import type { FileChange, KnowledgeGroup, ProjectDocument, ProjectSnapshot } from '../shared/model';
import { setMetadata, setTitle } from '../shared/editing';
import { readHeader } from '../shared/markdown';
import { documentAliases } from '../shared/document-aliases';
import { graphChanges } from '../shared/graph-editing';
import { commitProject } from './project-client';
import './project-directory.css';

type DirectoryTab = 'documents' | 'favorites' | 'recent';
type EditKind = 'title' | 'aliases' | 'color' | 'group' | 'category';
type DirectoryState = { tab: DirectoryTab; group: string; page: number; favorites: string[]; recent: string[]; pinned: string[] };
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
};

const pageSize = 8;
const initialState = (): DirectoryState => ({ tab: 'documents', group: '', page: 0, favorites: [], recent: [], pinned: [] });
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
  private dragging?: string;
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
    this.render();
  }

  private storageKey() { return `cewen-directory:${this.snapshot?.project.id ?? ''}`; }
  private loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey()) ?? '{}') as Partial<DirectoryState>;
      this.state = { ...initialState(), ...raw, favorites: Array.isArray(raw.favorites) ? raw.favorites : [], recent: Array.isArray(raw.recent) ? raw.recent : [], pinned: Array.isArray(raw.pinned) ? raw.pinned : [] };
      if (!['documents', 'favorites', 'recent'].includes(this.state.tab)) this.state.tab = 'documents';
      this.state.page = Math.max(0, Number(this.state.page) || 0);
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
    if (!this.snapshot || this.snapshot.project.id !== next.project.id) {
      this.snapshot = next; this.loadState(); this.query = ''; this.expanded.clear(); this.listScroll.clear();
    } else this.snapshot = next;
    // 外部图谱或目录操作可以改变筛选；输入正在编辑时以用户当前文字为准。
    if (document.activeElement !== this.root.querySelector('[data-role=search]') && this.options.getQuery) this.query = this.options.getQuery();
    if (this.options.getGroup && this.state.tab === 'documents') {
      const group = this.options.getGroup() ?? '';
      if (group !== this.state.group) { this.state.group = group; this.locateGroupPage(group); }
    }
    this.draw();
  }

  private groups() { return this.snapshot!.groups.filter(group => group.id !== 'system-unassigned'); }
  private group(id: string) { return this.snapshot!.groups.find(group => group.id === id); }
  private locateGroupPage(id: string) {
    const rest = this.groups().filter(group => !this.state.pinned.includes(group.id));
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
      const groupA = a.system || 'system-unassigned', groupB = b.system || 'system-unassigned';
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
    const docs = this.snapshot!.documents.filter(doc => doc.type !== 'guide' && doc.status !== 'archived');
    const query = this.query.trim().toLocaleLowerCase();
    if (query) return this.ordered(docs.filter(doc => this.matched(doc, query)));
    if (this.state.tab === 'favorites') return this.ordered(docs.filter(doc => this.state.favorites.includes(doc.id)));
    if (this.state.tab === 'recent') return this.state.recent.map(id => docs.find(doc => doc.id === id)).filter((doc): doc is ProjectDocument => Boolean(doc));
    if (!this.state.group) return this.ordered(docs);
    return this.ordered(docs.filter(doc => doc.system === this.state.group || (this.state.group === 'system-unassigned' && !this.group(doc.system))));
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
    const content = document.createElement('div'); content.className = 'project-directory-content';
    const categories = document.createElement('nav'); categories.className = 'project-directory-categories'; categories.setAttribute('aria-label', '文档分类');
    const all = this.button('全部', 'group:'); all.className = 'project-directory-category'; all.classList.toggle('active', !this.state.group); categories.append(all);
    const available = this.groups();
    const pinned = available.filter(group => this.state.pinned.includes(group.id));
    const rest = available.filter(group => !this.state.pinned.includes(group.id));
    const maxPage = Math.max(0, Math.ceil(rest.length / pageSize) - 1);
    this.state.page = Math.min(this.state.page, maxPage);
    for (const group of [...pinned, ...rest.slice(this.state.page * pageSize, (this.state.page + 1) * pageSize)]) categories.append(this.categoryRow(group));
    if (this.snapshot.groups.some(group => group.id === 'system-unassigned')) categories.append(this.categoryRow(this.group('system-unassigned')!));
    if (!this.snapshot.historical) { const add = this.button('＋ 分类', 'new-category'); add.className = 'project-directory-add-category'; categories.append(add); }
    const pager = document.createElement('div'); pager.className = 'project-directory-pager';
    const previous = this.button('‹', 'page:-1', '上一页分类'); previous.disabled = this.state.page === 0;
    const next = this.button('›', 'page:1', '下一页分类'); next.disabled = this.state.page === maxPage;
    const count = document.createElement('span'); count.textContent = `${this.state.page + 1} / ${maxPage + 1}`; pager.append(previous, count, next); categories.append(pager);
    content.append(categories);
    const items = document.createElement('div'); items.className = 'project-directory-items'; items.setAttribute('role', 'list');
    const documents = this.visibleDocuments();
    if (!documents.length) { const empty = document.createElement('p'); empty.className = 'project-directory-empty'; empty.textContent = this.query ? '没有匹配的文档' : this.state.tab === 'favorites' ? '尚未收藏文档' : this.state.tab === 'recent' ? '尚无最近打开的文档' : '此分类暂无文档'; items.append(empty); }
    for (const doc of documents) items.append(this.documentRow(doc));
    content.append(items); this.root.append(content);
    if (this.edit) this.root.append(this.editor());
    const footer = document.createElement('div'); footer.className = 'project-directory-footer';
    const total = document.createElement('span'); total.textContent = `${documents.length} 份文档`; footer.append(total);
    this.root.append(footer);
    this.renderedKey = `${this.state.tab}:${this.state.group}:${this.query}`;
    items.scrollTop = this.listScroll.get(this.renderedKey) ?? 0;
    const focus = activeRole === 'search' ? search : activeRole.startsWith('editor:') ? this.root.querySelector<HTMLInputElement>(`.project-directory-editor [name="${activeRole.slice(7)}"]`) : null;
    if (focus) { focus.focus(); if (selection && focus instanceof HTMLInputElement) focus.setSelectionRange(selection[0], selection[1]); }
  }
  private categoryRow(group: KnowledgeGroup) {
    const row = document.createElement('div'); row.className = 'project-directory-category-row'; row.dataset.group = group.id;
    const button = this.button(group.label, `group:${group.id}`); button.className = 'project-directory-category'; button.classList.toggle('active', this.state.group === group.id);
    button.style.setProperty('--directory-color', group.color);
    const menu = this.button('⋯', `category-menu:${group.id}`, `${group.label}分类操作`); menu.className = 'project-directory-more';
    row.append(button); if (group.id !== 'system-unassigned' && !this.snapshot!.historical) row.append(menu); return row;
  }
  private documentRow(doc: ProjectDocument) {
    const row = document.createElement('div'); row.className = 'project-directory-row'; row.dataset.id = doc.id; row.draggable = !this.snapshot!.historical && !this.core(doc);
    row.setAttribute('role', 'listitem');
    if (this.options.getSelected?.() === doc.id) row.classList.add('active');
    const color = doc.color ?? this.group(doc.system)?.color ?? '#94A5BC'; row.style.setProperty('--directory-color', this.core(doc) ? '#CFB378' : color);
    const sections = this.snapshot!.nodes.filter(node => node.documentId === doc.id && node.kind === 'rule');
    if (sections.length) {
      const expand = this.button(this.expanded.has(doc.id) ? '⌄' : '›', `expand:${doc.id}`, this.expanded.has(doc.id) ? '收起章节' : '展开章节'); expand.className = 'project-directory-expand'; row.append(expand);
    }
    const select = this.button(doc.title, `select:${doc.id}`); select.className = 'project-directory-title'; select.dataset.id = doc.id; select.title = doc.title; row.append(select);
    const favorite = this.button(this.state.favorites.includes(doc.id) ? '★' : '☆', `favorite:${doc.id}`, this.state.favorites.includes(doc.id) ? '取消收藏' : '收藏'); favorite.className = 'project-directory-favorite'; row.append(favorite);
    if (!this.core(doc)) { const more = this.button('⋯', `menu:${doc.id}`, `${doc.title}更多操作`); more.className = 'project-directory-more'; row.append(more); }
    if (this.expanded.has(doc.id) && sections.length) {
      const children = document.createElement('div'); children.className = 'project-directory-sections';
      for (const section of sections) { const child = this.button(section.title, `select:${section.id}`); child.className = 'project-directory-section'; child.title = section.title; children.append(child); }
      const wrap = document.createElement('div'); wrap.className = 'project-directory-entry'; wrap.append(row, children); return wrap;
    }
    return row;
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
      for (const group of this.snapshot!.groups) { const option = document.createElement('option'); option.value = group.id; option.textContent = group.label; option.selected = group.id === doc?.system; select.append(option); }
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
    const entries = category ? [['edit:category', '修改名称与颜色'], ['pin-group', this.state.pinned.includes(id) ? '取消置顶' : '置顶分类'], ['group-order:-1', '分类上移'], ['group-order:1', '分类下移']] : [['edit:title', '改名'], ['edit:aliases', '管理别名'], ['edit:color', '条目颜色'], ['edit:group', '移动分类'], ['order:-1', '上移'], ['order:1', '下移']];
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
    if (action.startsWith('group:')) { this.rememberScroll(); this.state.group = action.slice(6); this.state.tab = 'documents'; this.options.onGroup(this.state.group); this.saveState(); this.draw(); return; }
    if (action.startsWith('page:')) { this.state.page += Number(action.slice(5)); this.saveState(); this.draw(); return; }
    if (action.startsWith('select:')) {
      const id = action.slice(7);
      if (button.classList.contains('project-directory-title')) {
        const now = performance.now();
        if (this.lastTitleClick?.id === id && now - this.lastTitleClick.at < 350) { this.lastTitleClick = undefined; this.openEdit('title', id); return; }
        this.lastTitleClick = { id, at: now };
      }
      this.select(id); return;
    }
    if (action.startsWith('expand:')) { const id = action.slice(7); this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); this.draw(); return; }
    if (action.startsWith('favorite:')) { const id = action.slice(9); this.state.favorites = this.state.favorites.includes(id) ? this.state.favorites.filter(value => value !== id) : [...this.state.favorites, id]; this.saveState(); this.draw(); return; }
    if (action.startsWith('menu:')) { this.menu(action.slice(5), false, button); return; }
    if (action.startsWith('category-menu:')) { this.menu(action.slice(14), true, button); return; }
    if (action === 'new-category') { this.openEdit('category', 'new'); return; }
    if (action === 'edit-cancel') { this.edit = undefined; this.draw(); return; }
    if (action.startsWith('edit:')) { const [, kind, id] = action.split(':'); this.openEdit(kind as EditKind, id); return; }
    if (action.startsWith('pin-group:')) { const id = action.slice(10); this.state.pinned = this.state.pinned.includes(id) ? this.state.pinned.filter(value => value !== id) : [...this.state.pinned, id]; this.saveState(); this.draw(); return; }
    if (action.startsWith('group-order:')) { const [, direction, id] = action.split(':'); void this.reorderGroup(id, Number(direction)); return; }
    if (action.startsWith('order:')) { const [, direction, id] = action.split(':'); void this.reorder(id, Number(direction)); }
  };
  private doubleClick = (event: MouseEvent) => { const title = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-title'); if (title?.dataset.id) { event.preventDefault(); this.openEdit('title', title.dataset.id); } };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.edit) { this.edit = undefined; this.draw(); return; }
    if (event.key !== 'F2') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row');
    if (row?.dataset.id) { event.preventDefault(); this.openEdit('title', row.dataset.id); }
  };
  private input = (event: Event) => { if ((event.target as HTMLElement).dataset.role === 'search') { this.query = (event.target as HTMLInputElement).value; this.options.onQuery?.(this.query); this.draw(); } };

  private async commit(reason: string, changes: FileChange[]) {
    if (!changes.length || this.busy) return;
    const snapshot = this.snapshot!;
    if (snapshot.historical) throw new Error('历史版本只读，请返回最新工作稿。');
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
    return [{ path: 'PROJECT.md', baseHash: snapshot.projectEntry.hash, text: setMetadata(snapshot.projectEntry.text, { minimumAppVersion: '0.4.0', systems: groups.map(group => ({ id: group.id, title: group.label, color: group.color })) }) },
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
      const groups = id === 'new' ? [...this.groups(), { id: `system-${crypto.randomUUID()}`, label, color: value }] : this.groups().map(group => group.id === id ? { ...group, label, color: value } : group);
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
    if (this.core(doc) || doc.system === group) return;
    try { const result = graphChanges(this.snapshot!, { kind: 'classify', ids: [doc.id], group }); await this.commit(result.label, result.changes); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  private async reorder(id: string, direction: number) {
    const doc = this.snapshot!.documents.find(item => item.id === id); if (!doc || this.core(doc) || !this.snapshot!.projectEntry) return;
    const group = doc.system || 'system-unassigned';
    const ordered = this.ordered(this.snapshot!.documents.filter(item => !this.core(item) && (item.system || 'system-unassigned') === group));
    const index = ordered.findIndex(item => item.id === id), other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
    await this.writeOrder(group, ordered.map(item => item.id));
  }
  private async reorderGroup(id: string, direction: number) {
    const groups = this.groups(), index = groups.findIndex(group => group.id === id), other = index + direction;
    if (index < 0 || other < 0 || other >= groups.length) return;
    [groups[index], groups[other]] = [groups[other], groups[index]];
    try { await this.commit('调整设计分类顺序', this.categoryChanges(groups)); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  private async writeOrder(group: string, ids: string[]) {
    const snapshot = this.snapshot!, entry = snapshot.projectEntry; if (!entry) return;
    const order = this.orderMap(); order[group] = ids;
    await this.commit('调整文档顺序', [{ path: 'PROJECT.md', baseHash: entry.hash, text: setMetadata(entry.text, { documentOrder: order }) }]);
  }
  private dragStart = (event: DragEvent) => { const row = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row'); this.dragging = row?.dataset.id; if (!this.dragging) return; event.dataTransfer?.setData('text/plain', this.dragging); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
  private dragOver = (event: DragEvent) => { if (!this.dragging) return; const target = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row'); if (!target) return; event.preventDefault(); this.root.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); target.classList.add('drop-target'); };
  private dragLeave = (event: DragEvent) => { const target = (event.target as HTMLElement).closest<HTMLElement>('.drop-target'); if (target && !target.contains(event.relatedTarget as Node)) target.classList.remove('drop-target'); };
  private drop = (event: DragEvent) => {
    if (!this.dragging) return; event.preventDefault();
    const source = this.snapshot!.documents.find(doc => doc.id === this.dragging), target = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row');
    this.root.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target'));
    this.dragging = undefined;
    if (!source || !target) return;
    if (target.dataset.group) { void this.classify(source, target.dataset.group); return; }
    const other = this.snapshot!.documents.find(doc => doc.id === target.dataset.id);
    if (!other || other.id === source.id) return;
    if (source.system !== other.system) { void this.classify(source, other.system || 'system-unassigned'); return; }
    const group = source.system || 'system-unassigned';
    const ids = this.ordered(this.snapshot!.documents.filter(doc => !this.core(doc) && (doc.system || 'system-unassigned') === group)).map(doc => doc.id);
    ids.splice(ids.indexOf(source.id), 1); ids.splice(ids.indexOf(other.id), 0, source.id); void this.writeOrder(group, ids);
  };
  private dragEnd = () => { this.dragging = undefined; this.root.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); };

  dispose() {
    this.root.removeEventListener('click', this.click); this.root.removeEventListener('dblclick', this.doubleClick);
    this.root.removeEventListener('keydown', this.keydown); this.root.removeEventListener('input', this.input); this.root.removeEventListener('submit', this.submit);
    this.root.removeEventListener('dragstart', this.dragStart); this.root.removeEventListener('dragover', this.dragOver); this.root.removeEventListener('dragleave', this.dragLeave); this.root.removeEventListener('drop', this.drop); this.root.removeEventListener('dragend', this.dragEnd);
    this.root.remove();
  }
}
