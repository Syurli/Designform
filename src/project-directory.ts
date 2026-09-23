import type { FileChange, KnowledgeGroup, ProjectDocument, ProjectSnapshot } from '../shared/model';
import { setMetadata, setTitle } from '../shared/editing';
import { readHeader } from '../shared/markdown';
import { documentAliases } from '../shared/document-aliases';
import { documentAncestors, effectiveDocumentParent, getRootDocumentId, groupAncestors, moveHierarchy } from '../shared/project-hierarchy';
import { commitProject } from './project-client';
import './project-directory.css';

type DirectoryTab = 'documents' | 'favorites' | 'recent';
type EditKind = 'title' | 'aliases' | 'color' | 'group' | 'category';
type DirectoryState = { tab: DirectoryTab; group: string; groupLevel: string; documentParent: string; page: number; favorites: string[]; recent: string[]; pinned: string[] };
type DirectoryOptions = {
  getSnapshot(): ProjectSnapshot;
  onSelect(id: string): void;
  onGroup(group: string): void;
  onCommit(snapshot: ProjectSnapshot): void;
  onError(message: string): void;
  getSelected?(): string | null;
  onQuery?(query: string): void;
  getQuery?(): string;
  getGroup?(): string | null;
  /** 写作页引用入口只允许浏览与拖出链接，不允许提交目录更改。 */
  linkOnly?: boolean;
};

const pageSize = 8;
const initialState = (): DirectoryState => ({ tab: 'documents', group: '', groupLevel: '', documentParent: '', page: 0, favorites: [], recent: [], pinned: [] });
const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

/** 项目侧栏只保存视图偏好；公开的标题、分类、顺序和颜色均走项目提交。 */
export class ProjectDirectory {
  private root = document.createElement('section');
  private snapshot?: ProjectSnapshot;
  private state = initialState();
  private query = '';
  private edit?: { kind: EditKind; id: string };
  private busy = false;
  private expanded = new Set<string>();
  private listScroll = new Map<string, number>();
  private dragging?: { kind: 'group' | 'document'; id: string };
  private dragDocument?: { projectId: string; documentId: string; path: string; title: string };
  private longPress?: number;
  private pressed?: HTMLElement;
  private pressStart?: { x: number; y: number };
  private renderedKey = '';
  private lastTitleClick?: { id: string; at: number };

  constructor(private host: HTMLElement, private options: DirectoryOptions) {
    this.root.className = 'project-directory';
    this.root.setAttribute('aria-label', '项目文档目录');
    host.append(this.root);
    this.root.addEventListener('click', this.click);
    this.root.addEventListener('dblclick', this.doubleClick);
    this.root.addEventListener('keydown', this.keydown);
    this.root.addEventListener('input', this.input);
    this.root.addEventListener('submit', this.submit);
    this.root.addEventListener('dragstart', this.dragStart);
    this.root.addEventListener('dragover', this.dragOver);
    this.root.addEventListener('dragleave', this.dragLeave);
    this.root.addEventListener('drop', this.drop);
    this.root.addEventListener('dragend', this.dragEnd);
    this.root.addEventListener('pointerdown', this.pointerDown);
    this.root.addEventListener('pointermove', this.pointerMove);
    this.root.addEventListener('pointerup', this.pointerUp);
    this.root.addEventListener('pointercancel', this.pointerUp);
    this.render();
  }

  private storageKey() { return `cewen-directory:${this.snapshot?.project.id ?? ''}`; }
  private loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey()) ?? '{}') as Partial<DirectoryState>;
      this.state = { ...initialState(), ...raw, favorites: Array.isArray(raw.favorites) ? raw.favorites : [], recent: Array.isArray(raw.recent) ? raw.recent : [], pinned: Array.isArray(raw.pinned) ? raw.pinned : [] };
      if (!['documents', 'favorites', 'recent'].includes(this.state.tab)) this.state.tab = 'documents';
      this.state.page = Math.max(0, Number(this.state.page) || 0);
      if (typeof raw.groupLevel !== 'string') this.state.groupLevel = this.group(this.state.group)?.parent ?? '';
    } catch { this.state = initialState(); }
  }
  private saveState() { try { localStorage.setItem(this.storageKey(), JSON.stringify(this.state)); } catch { /* 本地偏好写入失败不阻断公开文档编辑。 */ } }
  private rememberScroll() {
    const list = this.root.querySelector<HTMLElement>('.project-directory-items');
    if (list && this.renderedKey) this.listScroll.set(this.renderedKey, list.scrollTop);
  }

  /** 外部快照更新后重绘；搜索和当前分类页保持原位。 */
  render() {
    const next = this.options.getSnapshot();
    // 主程序启动时先挂载侧栏，再异步连接项目；空首屏只保留一个空容器。
    if (!next) { this.snapshot = undefined; this.root.replaceChildren(); return; }
    if (!this.snapshot || this.snapshot.project.id !== next.project.id) {
      this.snapshot = next; this.loadState(); this.query = ''; this.expanded.clear(); this.listScroll.clear();
    } else this.snapshot = next;
    // 外部图谱或目录操作可以改变筛选；输入正在编辑时以用户当前文字为准。
    if (document.activeElement !== this.root.querySelector('[data-role=search]') && this.options.getQuery) this.query = this.options.getQuery();
    if (this.options.getGroup && this.state.tab === 'documents') {
      const group = this.options.getGroup() ?? '';
      if (group !== this.state.group) { this.state.group = group; this.state.groupLevel = this.group(group)?.parent ?? ''; this.state.documentParent = ''; this.locateGroupPage(group); }
    }
    if (this.state.documentParent) {
      const parent = this.snapshot.documents.find(doc => doc.id === this.state.documentParent);
      if (!parent) this.state.documentParent = '';
      else { this.state.group = parent.system; if (this.state.groupLevel && !this.group(this.state.groupLevel)) this.state.groupLevel = ''; }
    }
    this.draw();
  }

  private groups() { return this.snapshot!.groups.filter(group => group.id !== 'system-unassigned'); }
  private group(id: string) { return this.snapshot!.groups.find(group => group.id === id); }
  private rootDocument() { const id = getRootDocumentId(this.snapshot!); return this.snapshot!.documents.find(doc => doc.id === id); }
  private siblingGroups() { return this.groups().filter(group => (group.parent ?? '') === this.state.groupLevel); }
  private locateGroupPage(id: string) {
    const rest = this.groups().filter(group => (group.parent ?? '') === (this.group(id)?.parent ?? '') && !this.state.pinned.includes(group.id));
    const index = rest.findIndex(group => group.id === id);
    if (index >= 0) this.state.page = Math.floor(index / pageSize);
  }
  private core(doc: ProjectDocument) { return doc.type === 'gdd'; }
  private aliases(doc: ProjectDocument) { try { return documentAliases(readHeader(doc.text).metadata.aliases); } catch { return []; } }
  private orderMap(): Record<string, string[]> {
    try {
      const raw = readHeader(this.snapshot!.projectEntry?.text ?? '').metadata.documentOrder;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).filter((id): id is string => typeof id === 'string')])) as Record<string, string[]>;
    } catch { return {}; }
  }
  private ordered(docs: ProjectDocument[]) {
    const order = this.orderMap();
    return [...docs].sort((a, b) => {
      if (this.core(a) !== this.core(b)) return this.core(a) ? -1 : 1;
      const parentA = effectiveDocumentParent(this.snapshot!, a.id), parentB = effectiveDocumentParent(this.snapshot!, b.id);
      const groupA = parentA?.kind === 'document' ? `document:${parentA.id}` : parentA?.id ?? 'system-unassigned';
      const groupB = parentB?.kind === 'document' ? `document:${parentB.id}` : parentB?.id ?? 'system-unassigned';
      if (groupA === groupB) {
        const row = order[groupA] ?? [], ia = row.indexOf(a.id), ib = row.indexOf(b.id);
        if (ia !== ib) return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
      }
      return a.title.localeCompare(b.title, 'zh-CN');
    });
  }
  private matched(doc: ProjectDocument, query: string) {
    const terms = [doc.title, ...this.aliases(doc), this.group(doc.system)?.label ?? '', ...this.snapshot!.nodes.filter(node => node.documentId === doc.id && node.kind === 'rule').map(node => node.title)];
    return terms.some(value => value.toLocaleLowerCase().includes(query));
  }
  private visibleDocuments() {
    const docs = this.snapshot!.documents.filter(doc => doc.type !== 'guide' && doc.status !== 'archived' && !this.core(doc));
    const query = this.query.trim().toLocaleLowerCase();
    if (query) return this.ordered(docs.filter(doc => this.matched(doc, query)));
    if (this.state.tab === 'favorites') return this.ordered(docs.filter(doc => this.state.favorites.includes(doc.id)));
    if (this.state.tab === 'recent') return this.state.recent.map(id => docs.find(doc => doc.id === id)).filter((doc): doc is ProjectDocument => Boolean(doc));
    if (this.state.documentParent) return this.ordered(docs.filter(doc => effectiveDocumentParent(this.snapshot!, doc.id)?.id === this.state.documentParent));
    if (!this.state.group) return this.ordered(docs.filter(doc => effectiveDocumentParent(this.snapshot!, doc.id)?.kind === 'root'));
    return this.ordered(docs.filter(doc => {
      const parent = effectiveDocumentParent(this.snapshot!, doc.id);
      return parent?.kind === 'group' && parent.id === this.state.group;
    }));
  }
  private button(label: string, action: string, title = label) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.action = action; button.title = title; return button;
  }
  private draw() {
    if (!this.snapshot) return;
    const active = document.activeElement as HTMLElement | null;
    const activeRole = active && this.root.contains(active) ? active.dataset.role ?? (active.closest('.project-directory-editor') ? `editor:${(active as HTMLInputElement).name}` : '') : '';
    const selection = active instanceof HTMLInputElement && ['text', 'search'].includes(active.type) ? [active.selectionStart, active.selectionEnd] : undefined;
    this.rememberScroll();
    this.root.replaceChildren();
    this.root.classList.toggle('project-directory-readonly', Boolean(this.snapshot.historical));
    const top = document.createElement('div'); top.className = 'project-directory-top';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索文档、别名与章节'; search.setAttribute('aria-label', '搜索所有分类'); search.value = this.query; search.dataset.role = 'search'; top.append(search);
    const tabs = document.createElement('div'); tabs.className = 'project-directory-tabs'; tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['documents', '文档'], ['favorites', '收藏'], ['recent', '最近']] as const) {
      const button = this.button(label, `tab:${id}`); button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.state.tab === id)); tabs.append(button);
    }
    top.append(tabs); this.root.append(top);
    // 总纲是独立固定入口，任何深度的分类和文档导航都不会挤走它。
    const rootDoc = this.rootDocument();
    if (rootDoc) { const rootCard = this.documentRow(rootDoc); rootCard.classList.add('project-directory-root-card'); this.root.append(rootCard); }
    const groupPath = document.createElement('div'); groupPath.className = 'project-directory-breadcrumb project-directory-group-path'; groupPath.setAttribute('aria-label', '分类路径');
    groupPath.append(this.crumb('全部分类', 'group:', 'root'));
    if (this.state.group) for (const ancestor of [...groupAncestors(this.snapshot, this.state.group), this.group(this.state.group)].filter((group): group is KnowledgeGroup => Boolean(group))) groupPath.append(this.crumb(ancestor.label, `group:${ancestor.id}`, ancestor.id));
    const currentCrumb = groupPath.lastElementChild as HTMLElement | null;
    if (currentCrumb) { currentCrumb.setAttribute('aria-current', 'location'); currentCrumb.title = `当前：${[...groupAncestors(this.snapshot, this.state.group).map(group => group.label), this.group(this.state.group)?.label].filter(Boolean).join(' › ') || '全部分类'}；可拖入上级路径调整层级`; }
    this.root.append(groupPath);
    // 分类路径独占侧栏全宽，长路径水平滚动到当前项，祖先始终可以回点或接收拖放。
    groupPath.scrollLeft = groupPath.scrollWidth;
    const content = document.createElement('div'); content.className = 'project-directory-content';
    const categories = document.createElement('nav'); categories.className = 'project-directory-categories'; categories.setAttribute('aria-label', '文档分类');
    const categoryHeading = document.createElement('div'); categoryHeading.className = 'project-directory-category-heading'; categoryHeading.textContent = this.state.groupLevel ? `${this.group(this.state.groupLevel)?.label ?? '当前'}的子分类` : '顶层分类'; categoryHeading.title = categoryHeading.textContent; categories.append(categoryHeading);
    const available = this.siblingGroups();
    const pinned = available.filter(group => this.state.pinned.includes(group.id));
    const rest = available.filter(group => !this.state.pinned.includes(group.id));
    const maxPage = Math.max(0, Math.ceil(rest.length / pageSize) - 1);
    this.state.page = Math.min(this.state.page, maxPage);
    for (const group of [...pinned, ...rest.slice(this.state.page * pageSize, (this.state.page + 1) * pageSize)]) categories.append(this.categoryRow(group));
    if (!this.state.groupLevel && this.snapshot.groups.some(group => group.id === 'system-unassigned')) categories.append(this.categoryRow(this.group('system-unassigned')!));
    if (!this.snapshot.historical && !this.options.linkOnly) { const add = this.button('＋ 分类', 'new-category'); add.className = 'project-directory-add-category'; categories.append(add); }
    const pager = document.createElement('div'); pager.className = 'project-directory-pager';
    const previous = this.button('‹', 'page:-1', '上一页分类'); previous.disabled = this.state.page === 0;
    const next = this.button('›', 'page:1', '下一页分类'); next.disabled = this.state.page === maxPage;
    const count = document.createElement('span'); count.textContent = `${this.state.page + 1} / ${maxPage + 1}`; pager.append(previous, count, next); categories.append(pager);
    content.append(categories);
    const documentPane = document.createElement('div'); documentPane.className = 'project-directory-document-pane';
    const documentPath = document.createElement('div'); documentPath.className = 'project-directory-breadcrumb'; documentPath.setAttribute('aria-label', '文档路径');
    documentPath.append(this.crumb(this.group(this.state.group)?.label ?? '总纲', 'document-parent:', this.state.group || 'root'));
    if (this.state.documentParent) for (const ancestor of [...documentAncestors(this.snapshot, this.state.documentParent), this.snapshot.documents.find(doc => doc.id === this.state.documentParent)].filter((doc): doc is ProjectDocument => Boolean(doc))) documentPath.append(this.crumb(ancestor.title, `document-parent:${ancestor.id}`, ancestor.id));
    documentPane.append(documentPath);
    const items = document.createElement('div'); items.className = 'project-directory-items'; items.setAttribute('role', 'list');
    const documents = this.visibleDocuments();
    if (!documents.length) { const empty = document.createElement('p'); empty.className = 'project-directory-empty'; empty.textContent = this.query ? '没有匹配的文档' : this.state.tab === 'favorites' ? '尚未收藏文档' : this.state.tab === 'recent' ? '尚无最近打开的文档' : !this.state.group ? '选择左侧分类查看文档' : '此分类暂无文档'; items.append(empty); }
    for (const doc of documents) items.append(this.documentRow(doc));
    documentPane.append(items); content.append(documentPane); this.root.append(content);
    if (this.edit) this.root.append(this.editor());
    const footer = document.createElement('div'); footer.className = 'project-directory-footer';
    const total = document.createElement('span'); total.textContent = `${documents.length} 份文档`; footer.append(total);
    this.root.append(footer);
    this.renderedKey = `${this.state.tab}:${this.state.group}:${this.state.groupLevel}:${this.state.documentParent}:${this.query}`;
    items.scrollTop = this.listScroll.get(this.renderedKey) ?? 0;
    const focus = activeRole === 'search' ? search : activeRole.startsWith('editor:') ? this.root.querySelector<HTMLInputElement>(`.project-directory-editor [name="${activeRole.slice(7)}"]`) : null;
    if (focus) { focus.focus(); if (selection && focus instanceof HTMLInputElement) focus.setSelectionRange(selection[0], selection[1]); }
  }
  private crumb(label: string, action: string, target: string) {
    const button = this.button(label, action, `前往${label}；拖到这里可提升层级`);
    button.className = 'project-directory-crumb'; button.dataset.crumbTarget = target;
    return button;
  }
  private categoryRow(group: KnowledgeGroup) {
    const row = document.createElement('div'); row.className = 'project-directory-category-row'; row.dataset.group = group.id;
    if (!this.snapshot!.historical && !this.options.linkOnly && group.id !== 'system-unassigned') { row.dataset.dragSource = 'group'; row.draggable = true; }
    if (row.dataset.dragSource) row.append(this.dragHandle(group.label));
    const button = this.button(group.label, `group:${group.id}`); button.className = 'project-directory-category'; button.classList.toggle('active', this.state.group === group.id);
    button.style.setProperty('--directory-color', group.color);
    button.title = `查看${group.label}的文档`;
    const menu = this.button('⋯', `category-menu:${group.id}`, `${group.label}分类操作`); menu.className = 'project-directory-more';
    row.append(button);
    if (this.groups().some(item => item.parent === group.id)) { const enter = this.button('›', `enter-group:${group.id}`, `进入${group.label}的子分类`); enter.className = 'project-directory-enter-group'; row.append(enter); }
    if (group.id !== 'system-unassigned' && !this.snapshot!.historical && !this.options.linkOnly) row.append(menu); return row;
  }
  private documentRow(doc: ProjectDocument) {
    const row = document.createElement('div'); row.className = 'project-directory-row'; row.dataset.id = doc.id;
    if (!this.snapshot!.historical) { row.dataset.dragSource = 'document'; row.draggable = true; row.append(this.dragHandle(doc.title)); }
    row.setAttribute('role', 'listitem');
    if (this.options.getSelected?.() === doc.id) row.classList.add('active');
    const color = doc.color ?? this.group(doc.system)?.color ?? '#94A5BC'; row.style.setProperty('--directory-color', this.core(doc) ? '#CFB378' : color);
    const sections = this.snapshot!.nodes.filter(node => node.documentId === doc.id && node.kind === 'rule');
    if (sections.length) {
      const expand = this.button(this.expanded.has(doc.id) ? '⌄' : '›', `expand:${doc.id}`, this.expanded.has(doc.id) ? '收起章节' : '展开章节'); expand.className = 'project-directory-expand'; row.append(expand);
    }
    const select = this.button(doc.title, `select:${doc.id}`); select.className = 'project-directory-title'; select.dataset.id = doc.id; select.title = doc.title; row.append(select);
    if (!this.core(doc) && this.snapshot!.documents.some(child => child.parent === doc.id && child.status !== 'archived')) { const enter = this.button('›', `document-parent:${doc.id}`, `进入${doc.title}的下级文档`); enter.className = 'project-directory-enter'; row.append(enter); }
    if (!this.core(doc)) { const favorite = this.button(this.state.favorites.includes(doc.id) ? '★' : '☆', `favorite:${doc.id}`, this.state.favorites.includes(doc.id) ? '取消收藏' : '收藏'); favorite.className = 'project-directory-favorite'; row.append(favorite); }
    if (!this.core(doc) && !this.options.linkOnly && !this.snapshot!.historical) { const more = this.button('⋯', `menu:${doc.id}`, `${doc.title}更多操作`); more.className = 'project-directory-more'; row.append(more); }
    if (this.expanded.has(doc.id) && sections.length) {
      const children = document.createElement('div'); children.className = 'project-directory-sections';
      for (const section of sections) { const child = this.button(section.title, `select:${section.id}`); child.className = 'project-directory-section'; child.title = section.title; children.append(child); }
      const wrap = document.createElement('div'); wrap.className = 'project-directory-entry'; wrap.append(row, children); return wrap;
    }
    return row;
  }
  private dragHandle(label: string) {
    const handle = document.createElement('span'); handle.className = 'project-directory-drag-handle'; handle.textContent = '⠿';
    handle.draggable = true; handle.title = `拖动${label}；也可按住条目约250毫秒后拖动`;
    handle.setAttribute('aria-label', handle.title); return handle;
  }

  private editor() {
    const panel = document.createElement('form'); panel.className = 'project-directory-editor'; panel.dataset.kind = this.edit!.kind;
    const doc = this.snapshot!.documents.find(item => item.id === this.edit!.id);
    const category = this.group(this.edit!.id);
    const heading = document.createElement('strong');
    heading.textContent = this.edit!.kind === 'category' ? `${category?.label ?? ''} · 分类设置` : `${doc?.title ?? ''} · ${this.edit!.kind === 'title' ? '改名' : this.edit!.kind === 'aliases' ? '别名' : this.edit!.kind === 'color' ? '条目颜色' : '移动分类'}`;
    panel.append(heading);
    if (this.edit!.kind === 'group') {
      const select = document.createElement('select'); select.name = 'value'; select.setAttribute('aria-label', '目标分类');
      for (const group of this.snapshot!.groups) { const option = document.createElement('option'); option.value = group.id; option.textContent = `${'　'.repeat(groupAncestors(this.snapshot!, group.id).length)}${group.label}`; option.selected = group.id === doc?.system; select.append(option); }
      panel.append(select);
    } else if (this.edit!.kind === 'color' || this.edit!.kind === 'category') {
      const input = document.createElement('input'); input.type = 'color'; input.name = 'value'; input.value = this.edit!.kind === 'category' ? category?.color ?? '#94A5BC' : doc?.color ?? this.group(doc?.system ?? '')?.color ?? '#94A5BC'; input.setAttribute('aria-label', '选择颜色'); panel.append(input);
      if (this.edit!.kind === 'color') { const inherit = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'inherit'; checkbox.checked = !doc?.color; inherit.append(checkbox, document.createTextNode('继承分类颜色')); panel.append(inherit); }
      if (this.edit!.kind === 'category') { const inputName = document.createElement('input'); inputName.name = 'label'; inputName.value = category?.label ?? ''; inputName.maxLength = 80; inputName.required = true; inputName.setAttribute('aria-label', '分类名称'); panel.append(inputName); }
    } else {
      const input = document.createElement('input'); input.name = 'value'; input.required = this.edit!.kind === 'title'; input.value = this.edit!.kind === 'title' ? doc?.title ?? '' : doc ? this.aliases(doc).join('，') : ''; input.maxLength = this.edit!.kind === 'title' ? 120 : 1600; input.setAttribute('aria-label', this.edit!.kind === 'title' ? '新名称' : '别名，用逗号分隔'); panel.append(input);
      if (this.edit!.kind === 'title') { const keep = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'keepAlias'; keep.append(checkbox, document.createTextNode('旧名称保留为别名')); panel.append(keep); }
    }
    const actions = document.createElement('div'); actions.className = 'project-directory-editor-actions';
    const cancel = this.button('取消', 'edit-cancel'); const save = document.createElement('button'); save.type = 'submit'; save.textContent = '保存'; save.disabled = this.busy; actions.append(cancel, save); panel.append(actions);
    return panel;
  }

  private menu(id: string, category: boolean, anchor: HTMLElement) {
    this.root.querySelector('.project-directory-popup')?.remove();
    const popup = document.createElement('div'); popup.className = 'project-directory-popup';
    const entries = category ? [['edit:category', '修改名称与颜色'], ['pin-group', this.state.pinned.includes(id) ? '取消置顶' : '置顶分类'], ['group-order:-1', '分类上移'], ['group-order:1', '分类下移'], ['hierarchy:outdent', '升一级'], ['hierarchy:indent', '降一级']] : [['edit:title', '改名'], ['edit:aliases', '管理别名'], ['edit:color', '条目颜色'], ['edit:group', '移动分类'], ['order:-1', '上移'], ['order:1', '下移'], ['hierarchy:outdent', '升一级'], ['hierarchy:indent', '降一级']];
    for (const [action, label] of entries) { const button = this.button(label, `${action}:${id}`); popup.append(button); }
    anchor.after(popup);
  }
  private openEdit(kind: EditKind, id: string) { if (this.snapshot?.historical) return; this.edit = { kind, id }; this.draw(); this.root.querySelector<HTMLInputElement>('.project-directory-editor input:not([type=checkbox]),.project-directory-editor select')?.focus(); }
  private select(id: string) {
    const doc = this.snapshot!.documents.find(item => item.id === id || this.snapshot!.nodes.some(node => node.id === id && node.documentId === item.id));
    if (doc) { this.state.recent = [doc.id, ...this.state.recent.filter(value => value !== doc.id)].slice(0, 30); this.saveState(); }
    this.options.onSelect(id); this.draw();
  }

  private click = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]'); if (!button) return;
    event.stopPropagation();
    const action = button.dataset.action!;
    if (action.startsWith('tab:')) { this.rememberScroll(); this.state.tab = action.slice(4) as DirectoryTab; this.saveState(); this.draw(); return; }
    if (action.startsWith('group:')) {
      this.rememberScroll(); this.state.group = action.slice(6);
      if (button.classList.contains('project-directory-crumb') && this.state.groupLevel !== this.state.group) this.state.groupLevel = this.group(this.state.group)?.parent ?? '';
      this.state.documentParent = ''; this.state.page = 0; this.state.tab = 'documents'; this.options.onGroup(this.state.group); this.saveState(); this.draw(); return;
    }
    if (action.startsWith('enter-group:')) { this.rememberScroll(); const id = action.slice(12); this.state.group = id; this.state.groupLevel = id; this.state.documentParent = ''; this.state.page = 0; this.state.tab = 'documents'; this.options.onGroup(id); this.saveState(); this.draw(); return; }
    if (action.startsWith('document-parent:')) { this.rememberScroll(); this.state.documentParent = action.slice(16); this.state.tab = 'documents'; this.saveState(); this.draw(); return; }
    if (action.startsWith('page:')) { this.state.page += Number(action.slice(5)); this.saveState(); this.draw(); return; }
    if (action.startsWith('select:')) {
      const id = action.slice(7);
      if (button.classList.contains('project-directory-title')) {
        const now = performance.now();
        if (!this.options.linkOnly && this.lastTitleClick?.id === id && now - this.lastTitleClick.at < 350) { this.lastTitleClick = undefined; this.openEdit('title', id); return; }
        this.lastTitleClick = { id, at: now };
      }
      this.select(id); return;
    }
    if (action.startsWith('expand:')) { const id = action.slice(7); this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); this.draw(); return; }
    if (action.startsWith('favorite:')) { const id = action.slice(9); this.state.favorites = this.state.favorites.includes(id) ? this.state.favorites.filter(value => value !== id) : [...this.state.favorites, id]; this.saveState(); this.draw(); return; }
    if (this.options.linkOnly && !action.startsWith('select:')) return;
    if (action.startsWith('menu:')) { this.menu(action.slice(5), false, button); return; }
    if (action.startsWith('category-menu:')) { this.menu(action.slice(14), true, button); return; }
    if (action === 'new-category') { this.openEdit('category', 'new'); return; }
    if (action === 'edit-cancel') { this.edit = undefined; this.draw(); return; }
    if (action.startsWith('edit:')) { const [, kind, id] = action.split(':'); this.openEdit(kind as EditKind, id); return; }
    if (action.startsWith('pin-group:')) { const id = action.slice(10); this.state.pinned = this.state.pinned.includes(id) ? this.state.pinned.filter(value => value !== id) : [...this.state.pinned, id]; this.saveState(); this.draw(); return; }
    if (action.startsWith('group-order:')) { const [, direction, id] = action.split(':'); void this.reorderGroup(id, Number(direction)); return; }
    if (action.startsWith('hierarchy:')) { const [, movement, id] = action.split(':'); void this.changeLevel(id, movement as 'indent' | 'outdent'); return; }
    if (action.startsWith('order:')) { const [, direction, id] = action.split(':'); void this.reorder(id, Number(direction)); }
  };
  private doubleClick = (event: MouseEvent) => { const title = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-title'); if (title?.dataset.id && !this.options.linkOnly) { event.preventDefault(); this.openEdit('title', title.dataset.id); } };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.edit) { this.edit = undefined; this.draw(); return; }
    if (event.key !== 'F2' || this.options.linkOnly) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row');
    if (row?.dataset.id) { event.preventDefault(); this.openEdit('title', row.dataset.id); }
  };
  private input = (event: Event) => { if ((event.target as HTMLElement).dataset.role === 'search') { this.query = (event.target as HTMLInputElement).value; this.options.onQuery?.(this.query); this.draw(); } };

  private async commit(reason: string, changes: FileChange[]) {
    if (!changes.length || this.busy) return;
    const snapshot = this.snapshot!;
    if (snapshot.historical || this.options.linkOnly) throw new Error('当前目录只读，请返回项目工作稿。');
    this.busy = true; this.draw();
    try {
      const updated = await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, actor: 'user', reason, changes });
      this.snapshot = updated; this.options.onCommit(updated); this.edit = undefined; this.draw();
    } catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
    finally { this.busy = false; this.draw(); }
  }
  private categoryChanges(groups: KnowledgeGroup[]): FileChange[] {
    const snapshot = this.snapshot!;
    if (!snapshot.projectEntry) throw new Error('项目入口尚未就绪，无法修改分类。');
    return [{ path: 'PROJECT.md', baseHash: snapshot.projectEntry.hash, text: setMetadata(snapshot.projectEntry.text, { minimumAppVersion: '0.7.0', systems: groups.map(group => ({ id: group.id, title: group.label, color: group.color, ...(group.parent ? { parent: group.parent } : {}) })) }) },
      ...snapshot.documents.filter(doc => doc.type === 'gdd' && Object.hasOwn(readHeader(doc.text).metadata, 'systems')).map(doc => ({ path: doc.path, baseHash: doc.hash, text: setMetadata(doc.text, { systems: undefined }) }))];
  }
  private async updateDocument(doc: ProjectDocument, values: { title?: string; aliases?: string[]; color?: string }) {
    let text = setMetadata(doc.text, { ...(values.aliases !== undefined ? { aliases: values.aliases.length ? values.aliases : undefined } : {}), ...(Object.hasOwn(values, 'color') ? { color: values.color || undefined } : {}) });
    if (values.title !== undefined && values.title !== doc.title) text = setTitle(text, values.title);
    if (text === doc.text) return;
    await this.commit(values.title !== undefined ? `重命名文档：${values.title}` : values.aliases !== undefined ? `更新文档别名：${doc.title}` : `更新文档颜色：${doc.title}`, [{ path: doc.path, baseHash: doc.hash, text }]);
  }
  private submit = (event: SubmitEvent) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.classList.contains('project-directory-editor') || !this.edit) return;
    event.preventDefault(); if (this.busy) return;
    const data = new FormData(event.target), value = String(data.get('value') ?? '').trim(), { kind, id } = this.edit;
    const doc = this.snapshot!.documents.find(item => item.id === id);
    if (kind === 'category') {
      const label = String(data.get('label') ?? '').trim(); if (!label || !validColor(value)) return;
      if (this.snapshot!.groups.some(group => group.id !== id && group.label === label)) { this.options.onError('已有同名分类。'); return; }
      const groups = id === 'new' ? [...this.groups(), { id: `system-${crypto.randomUUID()}`, label, color: value, ...(this.state.groupLevel ? { parent: this.state.groupLevel } : {}) }] : this.groups().map(group => group.id === id ? { ...group, label, color: value } : group);
      try { void this.commit(`更新设计分类：${label}`, this.categoryChanges(groups)); } catch (error) { this.options.onError(String(error)); }
      return;
    }
    if (!doc) return;
    if (kind === 'title') {
      if (!value) { this.options.onError('名称不能为空。'); return; }
      const aliases = data.has('keepAlias') && value !== doc.title ? documentAliases([...this.aliases(doc), doc.title]) : undefined;
      void this.updateDocument(doc, { title: value, ...(aliases ? { aliases } : {}) });
    } else if (kind === 'aliases') void this.updateDocument(doc, { aliases: documentAliases(value) });
    else if (kind === 'color') void this.updateDocument(doc, { color: data.has('inherit') ? '' : value });
    else if (kind === 'group') void this.classify(doc, value);
  };
  private async classify(doc: ProjectDocument, group: string) {
    if (this.core(doc)) return;
    try { await this.move('document', doc.id, group, 'inside'); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  private async reorder(id: string, direction: number) {
    const doc = this.snapshot!.documents.find(item => item.id === id); if (!doc || this.core(doc)) return;
    const parent = effectiveDocumentParent(this.snapshot!, id);
    const ordered = this.ordered(this.snapshot!.documents.filter(item => !this.core(item) && effectiveDocumentParent(this.snapshot!, item.id)?.id === parent?.id));
    const index = ordered.findIndex(item => item.id === id), other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    await this.move('document', id, ordered[other].id, direction < 0 ? 'before' : 'after');
  }
  private async reorderGroup(id: string, direction: number) {
    const group = this.group(id); if (!group) return;
    const groups = this.groups().filter(item => (item.parent ?? '') === (group.parent ?? ''));
    const index = groups.findIndex(item => item.id === id), other = index + direction;
    if (index < 0 || other < 0 || other >= groups.length) return;
    try { await this.move('group', id, groups[other].id, direction < 0 ? 'before' : 'after'); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  private async move(kind: 'group' | 'document', id: string, targetId: string, placement: 'before' | 'after' | 'inside') {
    if (this.busy || this.snapshot?.historical || this.options.linkOnly) return;
    try { const result = moveHierarchy(this.snapshot!, { kind, id, targetId, placement }); await this.commit(result.label, result.changes); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  private async changeLevel(id: string, movement: 'indent' | 'outdent') {
    const group = this.group(id), kind = group ? 'group' : 'document';
    if (movement === 'outdent') {
      const parentId = group?.parent ?? effectiveDocumentParent(this.snapshot!, id)?.id;
      if (!parentId) return;
      const grandparent = group ? this.group(parentId)?.parent ?? getRootDocumentId(this.snapshot!) : this.group(parentId) ? this.group(parentId)?.parent : effectiveDocumentParent(this.snapshot!, parentId)?.id;
      if (grandparent) await this.move(kind, id, grandparent, 'inside');
      return;
    }
    const siblings = group ? this.groups().filter(item => (item.parent ?? '') === (group.parent ?? '')) : this.ordered(this.snapshot!.documents.filter(item => effectiveDocumentParent(this.snapshot!, item.id)?.id === effectiveDocumentParent(this.snapshot!, id)?.id && !this.core(item)));
    const index = siblings.findIndex(item => item.id === id);
    if (index > 0) await this.move(kind, id, siblings[index - 1].id, 'inside');
  }
  /** 长按条目启用原生拖动；手柄本身随时可拖，避免单击时误排序。 */
  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.project-directory-drag-handle')) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-source]');
    if (!row || (event.target as HTMLElement).closest('.project-directory-more,.project-directory-favorite,.project-directory-expand')) return;
    this.pressed = row;
    this.pressStart = { x: event.clientX, y: event.clientY };
    this.longPress = window.setTimeout(() => { if (this.pressed === row) row.classList.add('drag-ready'); }, 250);
  };
  private pointerMove = (event: PointerEvent) => { if (this.pressStart && Math.hypot(event.clientX - this.pressStart.x, event.clientY - this.pressStart.y) > 8 && !this.pressed?.classList.contains('drag-ready')) this.pointerUp(); };
  private pointerUp = () => { if (this.longPress) window.clearTimeout(this.longPress); this.longPress = undefined; this.pressed?.classList.remove('drag-ready'); this.pressed = undefined; this.pressStart = undefined; };
  private dragStart = (event: DragEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-source]');
    if (!row || this.snapshot?.historical || (!row.classList.contains('drag-ready') && !(event.target as HTMLElement).closest('.project-directory-drag-handle'))) { event.preventDefault(); return; }
    const kind = row.dataset.dragSource as 'group' | 'document';
    const id = kind === 'group' ? row.dataset.group : row.dataset.id;
    if (!id) { event.preventDefault(); return; }
    this.dragging = { kind, id };
    if (kind === 'document') {
      const doc = this.snapshot!.documents.find(item => item.id === id)!;
      const payload = { projectId: this.snapshot!.project.id, documentId: id, path: doc.path, title: doc.title };
      this.dragDocument = payload;
      event.dataTransfer?.setData('application/x-cewen-document', JSON.stringify(payload));
      event.dataTransfer?.setData('text/plain', doc.title);
      window.dispatchEvent(new CustomEvent('cewen:document-drag-start', { detail: payload }));
    } else event.dataTransfer?.setData('text/plain', this.group(id)?.label ?? '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = this.options.linkOnly || (kind === 'document' && this.core(this.snapshot!.documents.find(doc => doc.id === id)!)) ? 'copy' : 'copyMove';
    this.pointerUp();
  };
  private dropTarget(event: DragEvent) {
    const element = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row,.project-directory-crumb');
    if (!element || !this.dragging || this.options.linkOnly) return;
    const kind = element.dataset.group ? 'group' : element.dataset.id ? 'document' : 'crumb';
    const targetId = element.dataset.group ?? element.dataset.id ?? element.dataset.crumbTarget;
    if (!targetId || targetId === this.dragging.id) return;
    const rootId = getRootDocumentId(this.snapshot!);
    if (this.dragging.kind === 'document' && (targetId === 'root' || targetId === rootId)) return;
    if (this.dragging.kind === 'group' && (targetId === 'system-unassigned' || this.snapshot!.documents.some(doc => doc.id === targetId && doc.type !== 'gdd'))) return;
    if (this.dragging.kind === 'group' && kind === 'document' && !this.core(this.snapshot!.documents.find(doc => doc.id === targetId)!)) return;
    if (this.dragging.kind === 'group' && this.group(targetId) && groupAncestors(this.snapshot!, targetId).some(group => group.id === this.dragging!.id)) return;
    if (this.dragging.kind === 'document' && this.snapshot!.documents.some(doc => doc.id === targetId) && documentAncestors(this.snapshot!, targetId).some(doc => doc.id === this.dragging!.id)) return;
    if (this.dragging.kind === 'document' && kind === 'crumb' && element.closest('.project-directory-categories') && targetId !== 'root' && !this.group(targetId)) return;
    const placement = kind === 'crumb' || kind === 'group' && this.dragging.kind === 'document' || kind === 'document' && this.core(this.snapshot!.documents.find(doc => doc.id === targetId)!) ? 'inside' : (() => {
      const rect = element.getBoundingClientRect(), fraction = (event.clientY - rect.top) / rect.height;
      return fraction < .26 ? 'before' : fraction > .74 ? 'after' : 'inside';
    })();
    const resolvedId = targetId === 'root' ? getRootDocumentId(this.snapshot!) : targetId;
    if (!resolvedId) return;
    return { element, targetId: resolvedId, placement: placement as 'before' | 'after' | 'inside' };
  }
  private clearDrop() { this.root.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach(item => item.classList.remove('drop-before', 'drop-after', 'drop-inside')); }
  private dragOver = (event: DragEvent) => {
    const target = this.dropTarget(event); if (!target || !this.dragging || this.snapshot?.historical) return;
    if (this.dragging.kind === 'document' && this.core(this.snapshot!.documents.find(doc => doc.id === this.dragging!.id)!)) return;
    event.preventDefault(); this.clearDrop(); target.element.classList.add(`drop-${target.placement}`);
    target.element.title = target.placement === 'inside' ? '放入此层级' : target.placement === 'before' ? '放在前面' : '放在后面';
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  };
  private dragLeave = (event: DragEvent) => { if (!this.root.contains(event.relatedTarget as Node)) this.clearDrop(); };
  private drop = (event: DragEvent) => {
    const target = this.dropTarget(event), source = this.dragging; this.clearDrop();
    if (!target || !source || this.snapshot?.historical || this.options.linkOnly) return;
    event.preventDefault(); event.stopPropagation();
    this.dragEnd();
    void this.move(source.kind, source.id, target.targetId, target.placement);
  };
  private dragEnd = () => { if (this.dragDocument) window.dispatchEvent(new CustomEvent('cewen:document-drag-end', { detail: this.dragDocument })); this.dragDocument = undefined; this.dragging = undefined; this.clearDrop(); this.pointerUp(); };

  dispose() {
    // 引用目录可能在拖动途中关闭；必须对称结束事件并清除长按计时器。
    this.dragEnd();
    this.root.removeEventListener('click', this.click); this.root.removeEventListener('dblclick', this.doubleClick);
    this.root.removeEventListener('keydown', this.keydown); this.root.removeEventListener('input', this.input); this.root.removeEventListener('submit', this.submit);
    this.root.removeEventListener('dragstart', this.dragStart); this.root.removeEventListener('dragover', this.dragOver); this.root.removeEventListener('dragleave', this.dragLeave); this.root.removeEventListener('drop', this.drop); this.root.removeEventListener('dragend', this.dragEnd);
    this.root.removeEventListener('pointerdown', this.pointerDown); this.root.removeEventListener('pointermove', this.pointerMove); this.root.removeEventListener('pointerup', this.pointerUp); this.root.removeEventListener('pointercancel', this.pointerUp);
    this.root.remove();
  }
}
