import type { KnowledgeGroup, ProjectDocument, ProjectSnapshot } from '../shared/model';
import { groupAncestors } from '../shared/project-hierarchy';
import { questionRoundKey } from '../shared/answer-handoff';
import { readHeader } from '../shared/markdown';
import { documentNameOrder } from '../shared/document-order';
import { isTransientProject } from '../shared/transient';
import { createElement as createLucideElement, ChevronDown, PanelLeft, PanelLeftOpen, PanelsTopLeft, ArrowLeft, CircleAlert } from 'lucide';
import { categoryColor } from './category-color';
import { showAppMenu } from './app-menu';
import { questionDocuments, questionSources, questionRecord, questionMatchesFilter, visibleProjectQuestions, questionFilterLabels, questionStatusLabels, type QuestionDirectoryState, type QuestionFilter, type QuestionRecords } from './project-question-model';
import './project-question-directory.css';

export type { QuestionDirectoryState, QuestionFilter, QuestionStateInfo, QuestionRecords } from './project-question-model';
export interface ProjectQuestionDirectoryOptions {
  onScope(group: string, documentId: string): void;
  onQuestion(id: string): void;
  onFilter(filter: QuestionFilter): void;
  onQuery(query: string): void;
  onArchived(show: boolean): void;
  onSummary(): void;
  onBack(): void;
}
type CategoryView = 'fixed' | 'standard' | 'drawer';
type ViewPreferences = { categoryView: CategoryView; groups: string[]; documents: string[]; closedRounds: string[] };
const viewLabels: Record<CategoryView, string> = { fixed: '固定：分类常开', standard: '标准：靠近展开', drawer: '抽屉：展开靠近的分类' };
const viewMemory = new Map<string, ViewPreferences>();
const initialView = (): ViewPreferences => ({ categoryView: 'standard', groups: [], documents: [], closedRounds: [] });
const validIds = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];

/** 项目策问目录只发出导航意图；草稿、答案、提交与筛选会话由 RoundQuestions 管理。 */
export class ProjectQuestionDirectory {
  private root = document.createElement('section');
  private abort = new AbortController();
  private snapshot?: ProjectSnapshot;
  private state!: QuestionDirectoryState;
  private records: QuestionRecords = {};
  private preferences = initialView();
  private categoryHover = false;
  private menuOpen = false;
  private closeMenu?: () => void;
  private drawerRoot = '';
  private drawerCollapsed = false;
  private hoverGroup = '';
  private composing = false;
  private searchDraft = '';
  private lastCategoryKey = '';
  private disposed = false;

  constructor(private host: HTMLElement, private options: ProjectQuestionDirectoryOptions) {
    this.root.className = 'project-question-directory'; this.root.setAttribute('aria-label', '项目策问目录');
    host.classList.add('project-question-directory-host'); host.append(this.root);
    this.root.addEventListener('click', this.click, { signal: this.abort.signal });
    this.root.addEventListener('keydown', this.keydown, { signal: this.abort.signal });
    this.root.addEventListener('input', event => {
      const input = event.target as HTMLInputElement; if (input.dataset.role !== 'question-search') return;
      this.searchDraft = input.value; if (!this.composing && !(event as InputEvent).isComposing) this.options.onQuery(input.value);
    }, { signal: this.abort.signal });
    this.root.addEventListener('change', event => { const input = event.target as HTMLInputElement; if (input.dataset.role === 'question-archived') this.options.onArchived(input.checked); }, { signal: this.abort.signal });
    // 中文组合输入结束后才更新目录搜索，不在候选词阶段重建输入框。
    this.root.addEventListener('compositionstart', event => { if ((event.target as HTMLElement).dataset.role === 'question-search') this.composing = true; }, { signal: this.abort.signal });
    this.root.addEventListener('compositionend', event => { if ((event.target as HTMLElement).dataset.role === 'question-search') { this.composing = false; this.options.onQuery((event.target as HTMLInputElement).value); } }, { signal: this.abort.signal });
    window.addEventListener('cewen-theme-change', () => this.draw(), { signal: this.abort.signal });
  }

  /** 更新状态记录会重算真实计数，不选择新题，也不触碰正在中央作答的 DOM。 */
  render(snapshot: ProjectSnapshot, state: QuestionDirectoryState, records: QuestionRecords): void {
    if (this.disposed) return;
    const changedProject = this.snapshot?.project.id !== snapshot.project.id, changedDocument = this.state?.documentId !== state.documentId;
    const changedScope = changedProject || this.state?.group !== state.group, changedQuestion = changedProject || this.state?.questionId !== state.questionId;
    if (changedProject) { this.closeMenu?.(); this.loadView(snapshot); this.categoryHover = false; this.drawerRoot = ''; this.hoverGroup = ''; this.lastCategoryKey = ''; }
    this.snapshot = snapshot; this.state = { ...state }; this.records = records;
    if (!this.composing) this.searchDraft = state.query;
    if ((changedDocument || changedQuestion) && state.documentId) {
      this.preferences.documents = [...new Set([...this.preferences.documents, state.documentId])];
      const question = snapshot.documents.find(doc => doc.id === state.questionId && doc.type === 'question');
      if (question) this.preferences.closedRounds = this.preferences.closedRounds.filter(key => key !== JSON.stringify([state.documentId, questionRoundKey(question)]));
    }
    if (changedScope && state.group && !['question-all', 'question-unlinked'].includes(state.group)) this.preferences.groups = [...new Set([...this.preferences.groups, ...groupAncestors(snapshot, state.group).map(group => group.id)])];
    this.draw();
  }
  private viewKey(projectId: string) { return `cewen-project-question-directory:${projectId}`; }
  private loadView(snapshot: ProjectSnapshot) {
    const projectId = snapshot.project.id, remembered = viewMemory.get(projectId); if (remembered) { this.preferences = remembered; return; }
    let result = initialView();
    if (!isTransientProject(projectId)) try {
      const value = JSON.parse(localStorage.getItem(this.viewKey(projectId)) ?? '{}');
      if (value && typeof value === 'object') result = { categoryView: ['fixed', 'standard', 'drawer'].includes(value.categoryView) ? value.categoryView : 'standard', groups: validIds(value.groups), documents: validIds(value.documents), closedRounds: validIds(value.closedRounds) };
    } catch { /* 损坏的独立展开偏好不阻断正式问题阅读。 */ }
    this.preferences = result; viewMemory.set(projectId, result);
  }
  private saveView() {
    if (!this.snapshot) return; const id = this.snapshot.project.id; viewMemory.set(id, this.preferences);
    if (!isTransientProject(id)) try { localStorage.setItem(this.viewKey(id), JSON.stringify(this.preferences)); } catch { /* 仅保存展开外观，不写策问答案或阅读偏好。 */ }
  }
  private button(label: string, action: string, id = '', title = label) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.action = action; if (id) button.dataset.id = id; button.title = title;
    button.dataset.focus = `${action}:${id}`; return button;
  }
  private icon(icon: typeof ChevronDown) { return createLucideElement(icon, { width: 15, height: 15, 'stroke-width': 1.65, 'aria-hidden': 'true' }); }
  private arrow(action: string, id: string, expanded: boolean) {
    const button = this.button('', action, id, expanded ? '收起' : '展开'); button.className = 'question-directory-arrow'; button.setAttribute('aria-label', button.title); button.setAttribute('aria-expanded', String(expanded)); button.append(this.icon(ChevronDown)); return button;
  }
  private allState(): QuestionDirectoryState { return { ...this.state, group: 'question-all', documentId: '' }; }
  private questions(ignoreSearchAndFilter = false) {
    return visibleProjectQuestions(this.snapshot!, ignoreSearchAndFilter ? { ...this.allState(), query: '', filter: 'all' } : this.allState(), this.records);
  }
  /** 选择或填写即算已回答；暂缓题及真正更新的题仍计入待处理数量。 */
  private pending(questions: ProjectDocument[]) { return questions.filter(question => question.status !== 'archived' && questionMatchesFilter(questionRecord(this.records, question.id), 'pending')).length; }
  private validSources(question: ProjectDocument) {
    const normal = new Set(questionDocuments(this.snapshot!).map(doc => doc.id)); return questionSources(this.snapshot!, question).filter(id => normal.has(id));
  }

  private draw() {
    if (!this.snapshot || this.disposed || this.composing) return;
    const active = this.root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusKey = active?.dataset.focus, searchFocused = active?.dataset.role === 'question-search';
    const selection = searchFocused ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : undefined;
    const categoryScroll = this.root.querySelector('.question-directory-categories')?.scrollTop ?? 0, listScroll = this.root.querySelector('.question-directory-items')?.scrollTop ?? 0;
    this.root.replaceChildren(); const all = this.questions(true), matched = this.questions(), normal = questionDocuments(this.snapshot);
    const normalIds = new Set(normal.map(doc => doc.id)), unlinked = matched.filter(question => !questionSources(this.snapshot!, question).some(id => normalIds.has(id)));
    const top = document.createElement('header'); top.className = 'question-directory-top';
    const heading = document.createElement('div'); heading.className = 'question-directory-heading';
    const title = document.createElement('strong'); title.textContent = '策问'; const count = document.createElement('small'); count.textContent = `待答 ${this.pending(all)}`;
    const back = this.button('返回', 'back', '', '返回策划案'); back.className = 'question-directory-back'; back.prepend(this.icon(ArrowLeft)); heading.append(title, count, back); top.append(heading);
    const search = document.createElement('input'); search.type = 'search'; search.value = this.searchDraft; search.placeholder = '搜索问题、来源文档…'; search.dataset.role = 'question-search'; search.setAttribute('aria-label', '搜索项目问题'); top.append(search);
    const filters = document.createElement('div'); filters.className = 'question-directory-filters'; filters.setAttribute('aria-label', '问题状态筛选');
    for (const [filter, label] of Object.entries(questionFilterLabels) as [QuestionFilter, string][]) { const button = this.button(label, 'filter', filter); button.setAttribute('aria-pressed', String(this.state.filter === filter)); filters.append(button); } top.append(filters);
    const scopes = document.createElement('div'); scopes.className = 'question-directory-scopes';
    for (const [id, label, count] of [['question-all', '全部问题', matched.length], ['question-unlinked', '未关联问题', unlinked.length]] as const) {
      const button = this.button(label, 'scope', id, id === 'question-all' ? '平铺当前项目的全部问题' : '没有有效普通来源文档的问题，原题与回答保留'); button.setAttribute('aria-pressed', String(this.state.group === id)); const total = document.createElement('small'); total.textContent = String(count); button.append(total); scopes.append(button);
    } top.append(scopes); this.root.append(top);

    const content = document.createElement('div'); content.className = 'question-directory-content'; const categories = document.createElement('div'); categories.className = 'question-directory-categories'; categories.setAttribute('role', 'tree'); categories.setAttribute('aria-label', '有问题的分类');
    const mode = this.button('', 'category-view', '', viewLabels[this.preferences.categoryView]); mode.className = 'question-directory-category-view'; mode.setAttribute('aria-label', mode.title); mode.setAttribute('aria-haspopup', 'menu'); mode.append(this.icon(this.preferences.categoryView === 'fixed' ? PanelLeft : this.preferences.categoryView === 'drawer' ? PanelsTopLeft : PanelLeftOpen)); categories.append(mode);
    categories.append(this.categoryRow({ id: '', label: '全部分类', color: '#94A5BC' })); this.appendCategories(categories, all, normal);
    categories.addEventListener('pointerenter', () => { if (!categories.isConnected) return; this.categoryHover = true; this.updateCategoryLayout(); });
    categories.addEventListener('pointerleave', () => { if (!categories.isConnected) return; this.categoryHover = false; if (!this.menuOpen) { this.hoverGroup = ''; this.drawerRoot = ''; } this.updateCategoryLayout(); });
    categories.addEventListener('pointermove', this.categoryPointerMove); content.append(categories);
    const pane = document.createElement('div'); pane.className = 'question-directory-pane'; const toolbar = document.createElement('div'); toolbar.className = 'question-directory-list-toolbar';
    const group = this.snapshot.groups.find(group => group.id === this.state.group), scopeName = this.state.group === 'question-all' ? '全部问题' : this.state.group === 'question-unlinked' ? '未关联问题' : group?.label ?? '全部分类';
    const color = document.createElement('i'); color.style.background = categoryColor(group?.color ?? '#94A5BC'); const scopeLabel = document.createElement('span'); scopeLabel.textContent = scopeName; toolbar.title = scopeName; toolbar.append(color, scopeLabel);
    const key = `${this.state.group}:${this.state.documentId}`; toolbar.classList.toggle('is-changing', !!this.lastCategoryKey && this.lastCategoryKey !== key); this.lastCategoryKey = key; pane.append(toolbar);
    const items = document.createElement('div'); items.className = 'question-directory-items'; items.setAttribute('role', 'list');
    const scoped = visibleProjectQuestions(this.snapshot, { ...this.state, documentId: '' }, this.records);
    if (this.state.group === 'question-all' || this.state.group === 'question-unlinked') {
      for (const question of scoped) items.append(this.questionRow(question));
    } else {
      const sources = new Map(normal.map(doc => [doc.id, [] as ProjectDocument[]]));
      for (const question of scoped) for (const id of questionSources(this.snapshot, question)) sources.get(id)?.push(question);
      for (const doc of normal.filter(doc => sources.get(doc.id)?.length).sort((a, b) => documentNameOrder.compare(a.title, b.title))) this.appendDocument(items, doc, sources.get(doc.id)!);
      const withoutSource = scoped.filter(question => !questionSources(this.snapshot!, question).some(id => normalIds.has(id)));
      if (withoutSource.length) { const title = document.createElement('p'); title.className = 'question-directory-section-heading'; title.textContent = '未关联问题'; items.append(title); for (const question of withoutSource) items.append(this.questionRow(question)); }
    }
    if (!scoped.length) { const empty = document.createElement('p'); empty.className = 'question-directory-empty'; empty.textContent = this.state.query || this.state.filter !== 'all' ? '当前范围没有匹配的问题。' : all.length ? '此分类及下级分类暂无问题。' : '项目暂无问题，可在策问区生成提问开场白或导入问题。'; items.append(empty); }
    pane.append(items); content.append(pane); this.root.append(content);
    const footer = document.createElement('footer'); footer.className = 'question-directory-footer';
    const path = document.createElement('span'); path.className = 'question-directory-path'; path.textContent = [['question-all', 'question-unlinked'].includes(this.state.group) ? scopeName : '全部分类', ...groupAncestors(this.snapshot, this.state.group).map(group => group.label), group?.label, normal.find(doc => doc.id === this.state.documentId)?.title].filter(Boolean).join(' › '); path.title = path.textContent; path.setAttribute('aria-label', '当前策问范围路径'); footer.append(path);
    const actions = document.createElement('div'); const archive = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.state.includeArchived; checkbox.dataset.role = 'question-archived'; archive.append(checkbox, document.createTextNode('含归档'));
    const summary = this.button('本轮汇总', 'summary'); summary.disabled = !all.length; const total = document.createElement('small'); total.textContent = `${scoped.length} 题`; actions.append(archive, total, summary); footer.append(actions); this.root.append(footer); this.updateCategoryLayout();
    categories.scrollTop = categoryScroll; items.scrollTop = listScroll;
    const focus = searchFocused ? search : focusKey ? this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`) : undefined;
    if (focus) { focus.focus({ preventScroll: true }); if (selection && focus instanceof HTMLInputElement) focus.setSelectionRange(selection[0], selection[1]); }
  }

  /** 只展示有问题的分类及其祖先，迭代渲染保留任意真实层级；异常父级只在显示层提供入口。 */
  private appendCategories(host: HTMLElement, questions: ProjectDocument[], docs: ProjectDocument[]) {
    const allowed = new Set<string>(), byDocument = new Map(docs.map(doc => [doc.id, doc]));
    for (const question of questions) {
      const groups = [question.system, ...questionSources(this.snapshot!, question).map(id => byDocument.get(id)?.system ?? '')];
      for (const id of groups.filter(Boolean)) { allowed.add(id); for (const ancestor of groupAncestors(this.snapshot!, id)) allowed.add(ancestor.id); }
    }
    const all = this.snapshot!.groups.filter(group => allowed.has(group.id)), byId = new Map(all.map(group => [group.id, group])), children = new Map<string, KnowledgeGroup[]>();
    for (const group of all) { const parent = group.parent && group.parent !== group.id && byId.has(group.parent) ? group.parent : ''; const siblings = children.get(parent) ?? []; siblings.push(group); children.set(parent, siblings); }
    const roots = [...children.get('') ?? []], covered = new Set<string>();
    const cover = (first: KnowledgeGroup) => { const queue = [first]; while (queue.length) { const group = queue.pop()!; if (covered.has(group.id)) continue; covered.add(group.id); queue.push(...children.get(group.id) ?? []); } }; roots.forEach(cover); for (const group of all) if (!covered.has(group.id)) { roots.push(group); cover(group); }
    const visited = new Set<string>(), stack = roots.reverse().map(group => ({ group, depth: 0, top: group.id }));
    while (stack.length) {
      const { group, depth, top } = stack.pop()!; if (visited.has(group.id)) continue; visited.add(group.id); const hasChildren = !!children.get(group.id)?.length; host.append(this.categoryRow(group, depth, top, hasChildren));
      const drawer = this.preferences.categoryView === 'drawer' && this.drawerRoot === top;
      if ((this.preferences.groups.includes(group.id) || drawer && depth === 0 && !this.drawerCollapsed) && (this.preferences.categoryView !== 'drawer' || drawer)) for (const child of [...children.get(group.id) ?? []].reverse()) stack.push({ group: child, depth: depth + 1, top });
    }
  }
  private categoryRow(group: KnowledgeGroup, depth = 0, top = group.id, children = false) {
    const row = document.createElement('div'); row.className = 'question-directory-category-row'; row.dataset.group = group.id; row.dataset.topGroup = top; row.style.setProperty('--category-depth', String(depth)); row.style.setProperty('--directory-color', categoryColor(group.color)); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(this.state.group === group.id));
    const button = this.button('', 'scope', group.id, group.id ? `汇总${group.label}及下级分类的问题` : '全部分类中的文档与问题'); button.className = 'question-directory-category'; button.setAttribute('aria-label', group.label);
    const initial = document.createElement('span'); initial.className = 'question-directory-category-initial'; initial.textContent = [...group.label][0]?.toUpperCase() ?? '·'; initial.setAttribute('aria-hidden', 'true'); const name = document.createElement('span'); name.className = 'question-directory-category-name'; name.textContent = group.label; button.append(initial, name); row.append(button);
    if (children) { const expanded = this.preferences.groups.includes(group.id) || this.preferences.categoryView === 'drawer' && this.drawerRoot === top && depth === 0 && !this.drawerCollapsed; row.setAttribute('aria-expanded', String(expanded)); row.append(this.arrow('expand-group', group.id, expanded)); } return row;
  }
  private appendDocument(host: HTMLElement, doc: ProjectDocument, questions: ProjectDocument[]) {
    const group = this.snapshot!.groups.find(group => group.id === doc.system), expanded = this.preferences.documents.includes(doc.id);
    const entry = document.createElement('div'); entry.className = 'question-directory-document'; const row = document.createElement('div'); row.className = 'question-directory-document-row'; row.classList.toggle('active', this.state.documentId === doc.id); row.style.setProperty('--directory-color', categoryColor(doc.color ?? group?.color ?? '#94A5BC'));
    const title = this.button(doc.title, 'document', doc.id); title.className = 'question-directory-document-title'; title.setAttribute('aria-expanded', String(expanded)); const count = document.createElement('small'); count.textContent = `待答 ${this.pending(questions)}`; count.title = `共 ${questions.length} 题`; row.append(title, count, this.arrow('expand-document', doc.id, expanded)); entry.append(row);
    if (expanded) {
      const rounds = new Map<string, ProjectDocument[]>(); for (const question of questions) { const key = questionRoundKey(question), list = rounds.get(key) ?? []; list.push(question); rounds.set(key, list); }
      for (const [round, questions] of rounds) {
        const key = JSON.stringify([doc.id, round]), open = !this.preferences.closedRounds.includes(key), meta = readHeader(questions[0].text).metadata;
        const roundLabel = typeof meta.round === 'string' ? meta.round : '未分轮次';
        const section = document.createElement('div'); section.className = 'question-directory-round'; const heading = this.button('', 'round', key, roundLabel); heading.className = 'question-directory-round-heading'; heading.setAttribute('aria-expanded', String(open));
        const label = document.createElement('span'); label.textContent = roundLabel; const count = document.createElement('small'); count.textContent = String(questions.length); heading.append(label, count, this.icon(ChevronDown)); section.append(heading);
        if (open) for (const question of questions) section.append(this.questionRow(question, doc.id)); entry.append(section);
      }
    } host.append(entry);
  }
  private questionRow(question: ProjectDocument, documentId = '') {
    const record = questionRecord(this.records, question.id), status = record?.status ?? 'pending', sources = questionSources(this.snapshot!, question), valid = this.validSources(question);
    const button = this.button('', 'question', question.id, [question.title, questionStatusLabels[status], record?.reason, sources.length && !valid.length ? '来源失效，原题与回答保留' : !valid.length ? '未关联普通文档' : ''].filter(Boolean).join(' · ')); button.className = 'question-directory-question'; button.dataset.document = documentId; button.dataset.status = status; button.setAttribute('role', 'listitem'); button.setAttribute('aria-current', this.state.questionId === question.id ? 'step' : 'false');
    const title = document.createElement('span'); title.textContent = question.title; const detail = document.createElement('small'); detail.textContent = `${record?.blocked ? '待前题 · ' : ''}${questionStatusLabels[status]}${question.status === 'archived' ? ' · 归档' : ''}`; button.append(title, detail);
    if (status === 'review' || sources.length && !valid.length) { const alert = this.icon(CircleAlert); alert.classList.add('question-directory-warning'); button.append(alert); } return button;
  }

  private updateCategoryLayout() {
    const content = this.root.querySelector<HTMLElement>('.question-directory-content'); if (!content || !this.snapshot) return;
    content.dataset.categoryView = this.preferences.categoryView; content.classList.toggle('categories-open', this.preferences.categoryView === 'fixed' || this.categoryHover || this.menuOpen);
    const ancestors = new Set(groupAncestors(this.snapshot, this.hoverGroup).map(group => group.id));
    for (const row of content.querySelectorAll<HTMLElement>('.question-directory-category-row')) {
      row.classList.toggle('is-compressed-ancestor', ancestors.size > 3 && ancestors.has(row.dataset.group!)); row.classList.toggle('is-drawer-active', !row.dataset.group || row.dataset.topGroup === this.drawerRoot);
      row.hidden = this.preferences.categoryView === 'drawer' && Number(row.style.getPropertyValue('--category-depth')) > 0 && row.dataset.topGroup !== this.drawerRoot;
    }
  }
  private categoryPointerMove = (event: PointerEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.question-directory-category-row'); if (!row || !this.snapshot) return;
    const id = row.dataset.group ?? '', root = row.dataset.topGroup ?? '';
    if (id && (groupAncestors(this.snapshot, id).length >= groupAncestors(this.snapshot, this.hoverGroup).length || groupAncestors(this.snapshot, this.hoverGroup)[0]?.id !== root)) this.hoverGroup = id;
    if (this.preferences.categoryView === 'drawer' && root && root !== this.drawerRoot) { this.drawerRoot = root; this.drawerCollapsed = false; this.draw(); } else this.updateCategoryLayout();
  };
  private toggleGroup(id: string) {
    const auto = this.preferences.categoryView === 'drawer' && this.drawerRoot === id, expanded = this.preferences.groups.includes(id) || auto && !this.drawerCollapsed;
    this.preferences.groups = expanded ? this.preferences.groups.filter(value => value !== id) : [...this.preferences.groups, id]; if (auto) this.drawerCollapsed = expanded; this.saveView(); this.draw();
  }
  private modeMenu(anchor: HTMLElement) {
    this.closeMenu?.(); this.menuOpen = true; this.updateCategoryLayout();
    this.closeMenu = showAppMenu((Object.entries(viewLabels) as [CategoryView, string][]).map(([view, label]) => ({ label: `${this.preferences.categoryView === view ? '✓ ' : ''}${label}`, run: () => { this.preferences.categoryView = view; this.drawerRoot = ''; this.drawerCollapsed = false; this.saveView(); this.draw(); } })), anchor, undefined, { onClose: () => { this.menuOpen = false; this.closeMenu = undefined; if (!this.categoryHover) { this.drawerRoot = ''; this.hoverGroup = ''; } this.updateCategoryLayout(); } });
  }
  private click = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]'); if (!button || !this.root.contains(button) || !this.snapshot) return;
    const action = button.dataset.action, id = button.dataset.id ?? ''; event.stopPropagation();
    if (action === 'back') this.options.onBack();
    else if (action === 'summary') this.options.onSummary();
    else if (action === 'filter') this.options.onFilter(id as QuestionFilter);
    else if (action === 'scope') { if (id && !['question-all', 'question-unlinked'].includes(id)) { if (this.preferences.categoryView === 'drawer') this.drawerRoot = groupAncestors(this.snapshot, id)[0]?.id ?? id; if (this.snapshot.groups.some(group => group.parent === id)) this.toggleGroup(id); } this.options.onScope(id, ''); }
    else if (action === 'document') { this.preferences.documents = [...new Set([...this.preferences.documents, id])]; this.saveView(); this.options.onScope(this.state.group, id); }
    else if (action === 'question') { const documentId = button.dataset.document ?? ''; if (documentId && documentId !== this.state.documentId) this.options.onScope(this.state.group, documentId); this.options.onQuestion(id); }
    else if (action === 'expand-group') this.toggleGroup(id);
    else if (action === 'expand-document') { this.preferences.documents = this.preferences.documents.includes(id) ? this.preferences.documents.filter(value => value !== id) : [...this.preferences.documents, id]; this.saveView(); this.draw(); }
    else if (action === 'round') { this.preferences.closedRounds = this.preferences.closedRounds.includes(id) ? this.preferences.closedRounds.filter(value => value !== id) : [...this.preferences.closedRounds, id]; this.saveView(); this.draw(); }
    else if (action === 'category-view') this.modeMenu(button);
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.isComposing || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.question-directory-category-row[aria-expanded]'); if (!row) return;
    const expanded = row.getAttribute('aria-expanded') === 'true'; if (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded) { event.preventDefault(); this.toggleGroup(row.dataset.group!); }
  };
  /** 退出只卸载事件与界面，展开偏好保留；不清理草稿或任何阅读状态。 */
  dispose(): void { if (this.disposed) return; this.disposed = true; this.saveView(); this.closeMenu?.(); this.abort.abort(); this.root.remove(); this.host.classList.remove('project-question-directory-host'); }
}
