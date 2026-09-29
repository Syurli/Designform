import { categoryColor } from './category-color';
import { showAppMenu,type AppCommand } from './app-menu';
import { isTransientProject } from '../shared/transient';
import type { FileChange, KnowledgeGroup, ProjectDocument, ProjectSnapshot } from '../shared/model';
import { setMetadata, setTitle } from '../shared/editing';
import { readHeader } from '../shared/markdown';
import { documentAliases } from '../shared/document-aliases';
import { documentAncestors, effectiveDocumentParent, getRootDocumentId, groupAncestors, moveHierarchy } from '../shared/project-hierarchy';
import { commitProject } from './project-client';
import { documentSortLabels, sortDocuments, type DocumentSort } from '../shared/document-order';
import { documentPinScope, favoriteCategoryAncestors, readDocumentListState, saveDocumentListState, type DocumentListState, type FavoriteCategory } from './document-list-state';
import { createElement as createLucideElement, ChevronDown, GripVertical, ArrowUpDown, Pin, PinOff, Star, PanelLeft, PanelLeftOpen, PanelsTopLeft } from 'lucide';
import './project-directory.css';

type DirectoryTab = 'documents' | 'favorites' | 'recent';
type EditKind = 'title' | 'aliases' | 'color' | 'group' | 'category' | 'favorite-category' | 'favorite-membership' | 'favorite-category-members';
type CategoryView = 'fixed' | 'standard' | 'drawer';
/** 筛选与树展开是视图状态，收藏、图钉和排序通过项目偏好共享。 */
type DirectoryState = { tab: DirectoryTab; group: string; favoriteGroup: string; expandedGroups: string[]; categoryView: CategoryView };
type DirectoryDropTarget = { element: HTMLElement; targetId: string; placement: 'before' | 'after' | 'inside'; mode: 'global' | 'favorite' | 'order' | 'hierarchy' };
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
  /** 归档开关由主工作区统一提供，收藏、最近与图钉使用同一筛选。 */
  includeArchived?:()=>boolean;
  /** 文档工作区先暂存目录修改，统一由保存命令提交。 */
  onStage?(reason:string,changes:FileChange[]):Promise<ProjectSnapshot>;
  onPin?(id:string):void;
  onSelectEvent?(id:string,event:MouseEvent):boolean;
  isSelected?(id:string):boolean;
  extraCommands?(id:string,category:boolean,anchor:HTMLElement):AppCommand[];
};

const initialState = (): DirectoryState => ({ tab: 'documents', group: '', favoriteGroup: '', expandedGroups: [], categoryView: 'standard' });
const categoryViewLabels: Record<CategoryView, string> = { fixed: '固定：分类常开', standard: '标准：靠近展开', drawer: '抽屉：展开靠近的分类' };
const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

/** 项目侧栏只保存视图偏好；公开的标题、分类、顺序和颜色均走项目提交。 */
export class ProjectDirectory {
  private root = document.createElement('section');
  private snapshot?: ProjectSnapshot;
  private state = initialState();
  private preferences!: DocumentListState;
  private query = '';
  private edit?: { kind: EditKind; id: string; documentIds?: string[] };
  private busy = false;
  private expanded = new Set<string>();
  private listScroll = new Map<string, number>();
  private dragging?: { kind: 'group' | 'document'; id: string };
  private dragDocument?: { projectId: string; documentId: string; path: string; title: string };
  private longPress?: number;
  private pressed?: HTMLElement;
  private pressStart?: { x: number; y: number };
  private renderedKey = '';
  /** 分类展开宽度属于布局，菜单、拖动与键盘聚焦均能暂时保持展开。 */
  private categoryHover = false;
  private categoryMenuOpen = false;
  private categoryMenuClose?: () => void;
  private drawerRoot = '';
  private drawerRootCollapsed = false;
  private hoverCategory = '';
  private suppressClick = false;
  private currentCategoryKey = '';
  private lastTitleClick?: { id: string; at: number };
  private lastOpenedDocument?: { id: string; at: number };

  constructor(private host: HTMLElement, private options: DirectoryOptions) {
    this.root.className = 'project-directory';
    this.root.setAttribute('aria-label', '项目文档目录');
    host.append(this.root);
    this.root.addEventListener('click', this.click);
    this.root.addEventListener('contextmenu',event=>{
      const row=(event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row');
      if(!row||this.options.linkOnly||this.snapshot?.historical)return;
      if(row.dataset.favoriteGroup){event.preventDefault();this.favoriteCategoryMenu(row.dataset.favoriteGroup,row,event);return;}
      const id=row.dataset.id??row.dataset.group;if(!id)return;
      event.preventDefault();this.menu(id,!!row.dataset.group,row,event);
    });
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
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointercancel', this.pointerUp);
    window.addEventListener('cewen:document-list-change', this.preferencesChanged);
    this.render();
  }

  private storageKey() { return `cewen-directory:${this.snapshot?.project.id ?? ''}`; }
  private loadState() {
    this.preferences = readDocumentListState(this.snapshot!);
    if(isTransientProject(this.snapshot?.project.id)){this.state=initialState();return;}
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey()) ?? '{}') as Partial<DirectoryState>;
      this.state = { tab: raw.tab ?? 'documents', group: typeof raw.group === 'string' ? raw.group : '', favoriteGroup: typeof raw.favoriteGroup === 'string' ? raw.favoriteGroup : '', expandedGroups: Array.isArray(raw.expandedGroups) ? raw.expandedGroups.filter(id => typeof id === 'string') : [], categoryView: ['fixed', 'standard', 'drawer'].includes(raw.categoryView ?? '') ? raw.categoryView! : 'standard' };
      if (!['documents', 'favorites', 'recent'].includes(this.state.tab)) this.state.tab = 'documents';
    } catch { this.state = initialState(); }
  }
  private saveState() { if(isTransientProject(this.snapshot?.project.id))return;try { localStorage.setItem(this.storageKey(), JSON.stringify(this.state)); } catch { /* 本地偏好写入失败不阻断公开文档编辑。 */ } }
  private savePreferences() { saveDocumentListState(this.snapshot!, this.preferences); }
  private preferencesChanged = (event: Event) => {
    if ((event as CustomEvent<{projectId:string}>).detail.projectId === this.snapshot?.project.id) this.draw();
  };
  private rememberScroll() {
    const list = this.root.querySelector<HTMLElement>('.project-directory-items');
    if (list && this.renderedKey) this.listScroll.set(this.renderedKey, list.scrollTop);
  }

  /** 外部快照更新后重绘，保留当前筛选及分类树展开状态。 */
  render() {
    const next = this.options.getSnapshot();
    // 主程序启动时先挂载侧栏，再异步连接项目；空首屏只保留一个空容器。
    if (!next) { this.snapshot = undefined; this.root.replaceChildren(); return; }
    if (!this.snapshot || this.snapshot.project.id !== next.project.id) {
      this.categoryMenuClose?.(); this.categoryHover = false; this.drawerRoot = ''; this.hoverCategory = '';
      this.snapshot = next; this.loadState(); this.query = ''; this.expanded.clear(); this.listScroll.clear();
    } else this.snapshot = next;
    // 外部图谱或目录操作可以改变筛选；输入正在编辑时以用户当前文字为准。
    if (document.activeElement !== this.root.querySelector('[data-role=search]') && this.options.getQuery) this.query = this.options.getQuery();
    if (this.options.getGroup && this.state.tab === 'documents') {
      const group = this.options.getGroup() ?? '';
      if (group !== this.state.group) { this.state.group = group; this.expandAncestors(group); }
    }
    if (this.state.group && !this.group(this.state.group)) this.state.group = '';
    if (this.state.favoriteGroup && this.state.favoriteGroup !== 'unfiled' && !this.preferences.favoriteCategories.some(category => category.id === this.state.favoriteGroup)) this.state.favoriteGroup = '';
    this.draw();
  }

  /** 定位时展开真实归属路径，不改写分类或文档关系。 */
  reveal(id:string){
    this.render();const doc=this.snapshot?.documents.find(d=>d.id===id);if(!doc)return;
    this.query='';this.state.tab='documents';this.state.group=this.core(doc)?'':doc.system||'system-unassigned';
    this.expandAncestors(doc.system);this.options.onQuery?.('');this.options.onGroup(this.state.group);this.saveState();this.draw();
  }
  rename(id:string){this.reveal(id);this.openEdit('title',id);}
  focusSearch(){this.root.querySelector<HTMLInputElement>('[data-role=search]')?.focus();}
  /** 从标签、引用等其他入口打开时也更新同一份最近记录。 */
  remember(id:string){if(!this.snapshot)return;this.preferences.recent=[id,...this.preferences.recent.filter(value=>value!==id)].slice(0,30);this.savePreferences();}
  favorite(id:string){return this.preferences?.favorites.includes(id) ?? false;}
  toggleFavorite(id:string){
    if(this.favorite(id)){
      this.preferences.favorites=this.preferences.favorites.filter(value=>value!==id);
      for(const category of this.preferences.favoriteCategories)category.documents=category.documents.filter(value=>value!==id);
    }else this.preferences.favorites.push(id);
    this.savePreferences();
  }
  /** 树菜单与文档更多菜单共用独立收藏分类；可把当前多选文档作为新分类的初始成员。 */
  addFavoriteCategory(ids: string[] = []) {
    if (!this.snapshot || this.snapshot.historical || this.options.linkOnly) return;
    this.state.tab = 'favorites'; this.options.onGroup(''); this.saveState();
    this.openEdit('favorite-category', 'new', this.favoriteDocumentIds(ids));
  }
  /** 批量设置多分类时保留未改动的混合选项，避免覆盖各文档原来的收藏关系。 */
  chooseFavoriteCategories(ids: string[]) {
    const documentIds = this.favoriteDocumentIds(ids);
    if (!documentIds.length || !this.snapshot || this.snapshot.historical || this.options.linkOnly) return;
    this.openEdit('favorite-membership', documentIds[0], documentIds);
  }
  private favoriteDocumentIds(ids: string[]) {
    return [...new Set(ids.map(id => this.snapshot?.documents.some(doc => doc.id === id) ? id : this.snapshot?.nodes.find(node => node.id === id && node.kind !== 'system')?.documentId).filter((id): id is string => !!id))];
  }
  private groups() { return this.snapshot!.groups.filter(group => group.id !== 'system-unassigned'); }
  private group(id: string) { return this.snapshot!.groups.find(group => group.id === id); }
  private expandAncestors(id: string) { this.state.expandedGroups = [...new Set([...this.state.expandedGroups, ...groupAncestors(this.snapshot!, id).map(group=>group.id)])]; }
  private core(doc: ProjectDocument) { return doc.type === 'gdd'; }
  private aliases(doc: ProjectDocument) { try { return documentAliases(readHeader(doc.text).metadata.aliases); } catch { return []; } }
  private pinScope() { return documentPinScope(this.state.tab, this.state.tab === 'favorites' ? this.state.favoriteGroup : this.state.tab === 'documents' ? this.state.group : ''); }
  private ordered(docs: ProjectDocument[], manual = false) { return sortDocuments(this.snapshot!, docs, manual ? 'manual' : this.preferences.sort, manual ? [] : this.preferences.categoryPins[this.pinScope()] ?? []); }
  private matched(doc: ProjectDocument, query: string) {
    const terms = [doc.title, String(readHeader(doc.text).metadata.purpose??''), JSON.stringify(readHeader(doc.text).metadata.tags??[]), ...this.aliases(doc), this.group(doc.system)?.label ?? '', ...this.snapshot!.nodes.filter(node => node.documentId === doc.id && node.kind === 'rule').map(node => node.title)];
    return terms.some(value => value.toLocaleLowerCase().includes(query));
  }
  private visibleDocuments() {
    const docs = this.snapshot!.documents.filter(doc => !doc.path.startsWith('docs/media/') && !['docs/README.md','docs/INDEX.md'].includes(doc.path) && !doc.id.startsWith('unidentified:') && (this.options.includeArchived?.() || doc.status !== 'archived'));
    const query = this.query.trim().toLocaleLowerCase();
    // 先确定当前分栏范围，再在范围内搜索；收藏与最近不继承正式分类。
    return this.ordered(docs.filter(doc => {
      if (query && !this.matched(doc, query)) return false;
      if (this.state.tab === 'recent') return this.preferences.recent.includes(doc.id);
      if (this.state.tab === 'favorites') {
        if (!this.preferences.favorites.includes(doc.id)) return false;
        if (!this.state.favoriteGroup) return true;
        if (this.state.favoriteGroup === 'unfiled') return !this.preferences.favoriteCategories.some(category => category.documents.includes(doc.id));
        return this.preferences.favoriteCategories.some(category => (category.id === this.state.favoriteGroup || favoriteCategoryAncestors(this.preferences.favoriteCategories, category.id).some(parent => parent.id === this.state.favoriteGroup)) && category.documents.includes(doc.id));
      }
      if(this.state.group==='system-unassigned')return !this.core(doc)&&(!doc.system||doc.system==='system-unassigned');
      return !this.state.group || doc.system === this.state.group || groupAncestors(this.snapshot!, doc.system).some(group => group.id === this.state.group);
    }));
  }
  private button(label: string, action: string, title = label) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.action = action; button.title = title; return button;
  }
  /** 局部目录直接生成 Lucide 细线图标，避免依赖主页面刷新全站图标。 */
  private iconButton(icon: typeof Pin, action: string, title: string) {
    const button = this.button('', action, title);
    button.setAttribute('aria-label', title);
    button.append(createLucideElement(icon, { width: 15, height: 15, 'stroke-width': 1.65, 'aria-hidden': 'true' }));
    return button;
  }
  /** 分类始终占据正常布局宽度；开启状态只改变栏宽，不产生覆盖文档的浮层。 */
  private updateCategoryLayout() {
    const content = this.root.querySelector<HTMLElement>('.project-directory-content');
    if (!content) return;
    content.dataset.categoryView = this.state.categoryView;
    content.classList.toggle('categories-open', this.state.categoryView === 'fixed' || this.categoryHover || this.categoryMenuOpen || this.dragging?.kind === 'group');
    const ancestors = new Set(this.hoverCategory ? this.state.tab === 'favorites' ? favoriteCategoryAncestors(this.preferences.favoriteCategories, this.hoverCategory).map(category => category.id) : groupAncestors(this.snapshot!, this.hoverCategory).map(group => group.id) : []);
    const compress = ancestors.size > 3;
    content.querySelectorAll<HTMLElement>('.project-directory-category-row').forEach(row => {
      // 深层路径只压缩祖先行；保留最多三级缩进，让当前名称始终有可读空间。
      row.classList.toggle('is-compressed-ancestor', compress && ancestors.has(row.dataset.group ?? row.dataset.favoriteGroup ?? ''));
      row.classList.toggle('is-drawer-active', !row.dataset.group && !row.dataset.favoriteGroup || row.dataset.topGroup === this.drawerRoot || row.dataset.favoriteGroup === this.drawerRoot);
      row.hidden = this.state.categoryView === 'drawer' && Number(row.style.getPropertyValue('--category-depth')) > 0 && row.dataset.topGroup !== this.drawerRoot;
    });
  }
  /** 抽屉沿所靠近的顶层分类展开，其他树保留入口，不占用横向名称空间。 */
  private categoryPointerMove = (event: PointerEvent) => {
    // 长按与原生拖动期间保持源节点及栏宽稳定，抽屉重绘会移除浏览器的拖动候选。
    if (this.pressed || this.dragging) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-category-row');
    const id = row?.dataset.group ?? row?.dataset.favoriteGroup ?? '';
    const nextRoot = row?.dataset.topGroup ?? row?.dataset.favoriteGroup ?? '';
    // 同一树内保留已探索的最深路径，移动到其祖先时不反复伸缩行高。
    if (id) {
      const currentPath = this.hoverCategory ? this.state.tab === 'favorites' ? favoriteCategoryAncestors(this.preferences.favoriteCategories, this.hoverCategory) : groupAncestors(this.snapshot!, this.hoverCategory) : [];
      const nextPath = this.state.tab === 'favorites' ? favoriteCategoryAncestors(this.preferences.favoriteCategories, id) : groupAncestors(this.snapshot!, id);
      if ((currentPath[0]?.id ?? this.hoverCategory) !== nextRoot || nextPath.length >= currentPath.length) this.hoverCategory = id;
    }
    if (this.state.categoryView === 'drawer' && nextRoot && nextRoot !== this.drawerRoot) {
      this.drawerRoot = nextRoot; this.drawerRootCollapsed = false; this.draw(); return;
    }
    this.updateCategoryLayout();
  };
  /** 菜单生命周期保留分类栏，避免鼠标从分类移入顶层菜单时收起。 */
  private keepCategoryMenu() {
    this.categoryMenuClose?.();
    this.categoryMenuOpen = true; this.updateCategoryLayout();
    return { onClose: () => {
      this.categoryMenuOpen = false; this.categoryMenuClose = undefined;
      if (!this.categoryHover) { this.drawerRoot = ''; this.hoverCategory = ''; }
      this.updateCategoryLayout();
    } };
  }
  /** 模式只存为项目视图偏好，与共享排序、置顶及收藏关系互不替代。 */
  private categoryViewMenu(anchor: HTMLElement) {
    const lifecycle = this.keepCategoryMenu();
    this.categoryMenuClose = showAppMenu((Object.entries(categoryViewLabels) as [CategoryView, string][]).map(([view, label]) => ({
      label: `${this.state.categoryView === view ? '✓ ' : ''}${label}`,
      run: () => { this.state.categoryView = view; this.drawerRoot = ''; this.drawerRootCollapsed = false; this.saveState(); this.draw(); }
    })), anchor, undefined, lifecycle);
  }
  private draw() {
    if (!this.snapshot) return;
    const active = document.activeElement as HTMLElement | null;
    const activeRole = active && this.root.contains(active) ? active.dataset.role ?? (active.closest('.project-directory-editor') ? `editor:${(active as HTMLInputElement).name}` : '') : '';
    const activeAction = active && this.root.contains(active) ? active.dataset.action : undefined;
    const selection = active instanceof HTMLInputElement && ['text', 'search'].includes(active.type) ? [active.selectionStart, active.selectionEnd] : undefined;
    const previousCategories=this.root.querySelector<HTMLElement>('.project-directory-categories');
    const categoryScroll=previousCategories?.scrollTop??0;
    this.rememberScroll();
    this.root.replaceChildren();
    this.root.classList.toggle('project-directory-readonly', Boolean(this.snapshot.historical));
    const top = document.createElement('div'); top.className = 'project-directory-top';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索文档、别名与章节'; search.setAttribute('aria-label', this.options.onStage?'搜索项目文档':'搜索所有分类'); search.value = this.query; search.dataset.role = 'search'; top.append(search);
    const tabs = document.createElement('div'); tabs.className = 'project-directory-tabs'; tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['documents', '文档'], ['favorites', '收藏'], ['recent', '最近']] as const) {
      const button = this.button(label, `tab:${id}`); button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.state.tab === id)); tabs.append(button);
    }
    top.append(tabs); this.root.append(top);
    // 总置顶只显示快捷入口，拖入不会移动文档，也不从下方列表移除文档。
    const global = document.createElement('section'); global.className = 'project-directory-global-pins'; global.dataset.globalPins = ''; global.setAttribute('aria-label', '总置顶区');
    const pinHeading = document.createElement('div'); pinHeading.className = 'project-directory-pin-heading';
    pinHeading.append(createLucideElement(Pin, { width: 12, height: 12, 'stroke-width': 1.65, 'aria-hidden': 'true' }), document.createTextNode('总置顶')); global.append(pinHeading);
    const pinItems = document.createElement('div'); pinItems.className = 'project-directory-pin-items'; pinItems.setAttribute('role', 'list');
    for (const id of this.preferences.globalPins) {
      const doc = this.snapshot.documents.find(item=>item.id===id && (this.options.includeArchived?.() || item.status!=='archived'));
      if (doc) pinItems.append(this.documentRow(doc, true));
    }
    global.classList.toggle('is-empty', !pinItems.childElementCount);
    if (!pinItems.childElementCount) { const hint = document.createElement('small'); hint.textContent = '按住文档后拖到这里置顶'; pinItems.append(hint); }
    global.append(pinItems); this.root.append(global);
    const content = document.createElement('div'); content.className = 'project-directory-content';
    content.classList.toggle('project-directory-without-categories', this.state.tab === 'recent');
    const categories = document.createElement('nav'); categories.className = 'project-directory-categories'; categories.setAttribute('aria-label', '文档分类');
    categories.addEventListener('pointerenter', () => { if (!categories.isConnected || this.pressed || this.dragging) return; this.categoryHover = true; this.updateCategoryLayout(); });
    categories.addEventListener('pointerleave', () => {
      // 重绘移除的旧分类栏不能清除新分类栏的悬停状态。
      if (!categories.isConnected) return;
      if (this.pressed || this.dragging) return;
      this.categoryHover = false;
      if (!this.categoryMenuOpen && !this.dragging) { this.drawerRoot = ''; this.hoverCategory = ''; }
      this.updateCategoryLayout();
    });
    categories.addEventListener('pointermove', this.categoryPointerMove);
    if (this.state.tab !== 'recent') {
      categories.setAttribute('role', 'tree');
      const mode = this.iconButton(this.state.categoryView === 'fixed' ? PanelLeft : this.state.categoryView === 'drawer' ? PanelsTopLeft : PanelLeftOpen, 'category-view', categoryViewLabels[this.state.categoryView]);
      mode.className = 'project-directory-category-view'; mode.setAttribute('aria-haspopup', 'menu'); categories.append(mode);
      categories.append(this.filterRow(this.state.tab === 'favorites' ? '全部收藏' : '全部文档', this.state.tab === 'favorites' ? 'favorite-group:' : 'group:', this.state.tab === 'favorites' ? !this.state.favoriteGroup : !this.state.group));
      if (this.state.tab === 'favorites') {
        categories.setAttribute('aria-label', '独立收藏分类');
        this.appendFavoriteTree(categories);
        categories.append(this.filterRow('未分类收藏', 'favorite-group:unfiled', this.state.favoriteGroup === 'unfiled'));
      } else this.appendCategoryTree(categories);
      if (!this.snapshot.historical && !this.options.linkOnly) {
        const add = this.button('＋ 分类', this.state.tab === 'favorites' ? 'new-favorite-category' : 'new-category');
        add.className = 'project-directory-add-category'; categories.append(add);
      }
      content.append(categories);
    }
    const documentPane = document.createElement('div'); documentPane.className = 'project-directory-document-pane';
    const toolbar = document.createElement('div'); toolbar.className = 'project-directory-list-toolbar';
    // 顶栏用当前分类颜色与名称承接筛选，切换时只做轻柔过渡。
    const currentGroup = this.state.tab === 'documents' ? this.group(this.state.group) : undefined;
    const currentFavorite = this.state.tab === 'favorites' ? this.preferences.favoriteCategories.find(category => category.id === this.state.favoriteGroup) : undefined;
    const currentLabel = currentGroup?.label ?? currentFavorite?.label ?? (this.state.tab === 'recent' ? '最近打开' : this.state.tab === 'favorites' ? this.state.favoriteGroup === 'unfiled' ? '未分类收藏' : '全部收藏' : '全部文档');
    const summary = document.createElement('div'); summary.className = 'project-directory-current-category'; summary.title = currentLabel;
    const colorBlock = document.createElement('span'); colorBlock.className = 'project-directory-current-color'; colorBlock.style.background = categoryColor(currentGroup?.color ?? currentFavorite?.color ?? '#94A5BC'); colorBlock.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = currentLabel; summary.append(colorBlock, label);
    const categoryKey = `${this.state.tab}:${this.state.group}:${this.state.favoriteGroup}`;
    summary.classList.toggle('is-changing', Boolean(this.currentCategoryKey && categoryKey !== this.currentCategoryKey)); this.currentCategoryKey = categoryKey;
    const sort = this.iconButton(ArrowUpDown, 'sort', `文档排序：${documentSortLabels[this.preferences.sort]}`); sort.className = 'project-directory-sort'; sort.setAttribute('aria-haspopup', 'menu'); toolbar.append(summary);
    if (this.state.tab === 'favorites' && !this.snapshot.historical && !this.options.linkOnly) {
      const organize = this.iconButton(Star, 'favorite-menu', '收藏整理'); organize.className = 'project-directory-sort'; organize.setAttribute('aria-haspopup', 'menu'); toolbar.append(organize);
    }
    toolbar.append(sort); documentPane.append(toolbar);
    if (currentFavorite?.description) {
      const description = document.createElement('p'); description.className = 'project-directory-favorite-description'; description.textContent = currentFavorite.description; description.title = currentFavorite.description; documentPane.append(description);
    }
    const items = document.createElement('div'); items.className = 'project-directory-items'; items.setAttribute('role', 'list');
    const documents = this.visibleDocuments();
    if (!documents.length) { const empty = document.createElement('p'); empty.className = 'project-directory-empty'; empty.textContent = this.query ? '没有匹配的文档' : this.state.tab === 'favorites' ? this.state.favoriteGroup ? '此收藏分类暂无文档，可拖入文档或在收藏整理中设置成员' : '尚未收藏文档，可点击文档右侧星标收藏' : this.state.tab === 'recent' ? '尚无最近打开的文档' : '此分类及下级分类暂无文档'; items.append(empty); }
    for (const doc of documents) items.append(this.documentRow(doc));
    documentPane.append(items); content.append(documentPane); this.root.append(content);
    if (this.edit) this.root.append(this.editor());
    const footer = document.createElement('div'); footer.className = 'project-directory-footer';
    const path = document.createElement('div'); path.className = 'project-directory-path'; path.setAttribute('aria-label', '当前筛选路径');
    path.textContent = this.state.tab === 'favorites' ? ['收藏', ...favoriteCategoryAncestors(this.preferences.favoriteCategories, this.state.favoriteGroup).map(category => category.label), this.state.favoriteGroup === 'unfiled' ? '未分类收藏' : this.preferences.favoriteCategories.find(category=>category.id===this.state.favoriteGroup)?.label ?? '全部收藏'].join(' › ') : this.state.tab === 'recent' ? '最近打开' : ['全部分类', ...groupAncestors(this.snapshot, this.state.group).map(group=>group.label), this.group(this.state.group)?.label].filter(Boolean).join(' › ');
    path.title = path.textContent; footer.append(path);
    const total = document.createElement('span'); total.textContent = `${documents.length} 份文档`; footer.append(total);
    this.root.append(footer);
    this.updateCategoryLayout();
    this.renderedKey = `${this.state.tab}:${this.state.tab==='favorites'?this.state.favoriteGroup:this.state.group}:${this.query}:${this.preferences.sort}`;
    items.scrollTop = this.listScroll.get(this.renderedKey) ?? 0;
    categories.scrollTop = categoryScroll;
    const focus = activeRole === 'search' ? search : activeRole.startsWith('editor:') ? this.root.querySelector<HTMLInputElement>(`.project-directory-editor [name="${activeRole.slice(7)}"]`) : activeAction ? this.root.querySelector<HTMLElement>(`[data-action="${CSS.escape(activeAction)}"]`) : null;
    if (focus) { focus.focus({ preventScroll: true }); if (selection && focus instanceof HTMLInputElement) focus.setSelectionRange(selection[0], selection[1]); }
  }
  /** 收起时保留中文首字或英文首字母及颜色，展开后显示完整名称。 */
  private categoryLabel(button: HTMLButtonElement, label: string, prefix = '') {
    button.replaceChildren();
    const initial = document.createElement('span'); initial.className = 'project-directory-category-initial'; initial.textContent = [...label.trim()][0]?.toUpperCase() ?? '·'; initial.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'project-directory-category-name'; name.textContent = `${prefix}${label}`;
    button.setAttribute('aria-label', label); button.append(initial, name);
  }
  private filterRow(label: string, action: string, active: boolean) {
    const row = document.createElement('div'); row.className = 'project-directory-category-row'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', '1'); row.setAttribute('aria-selected', String(active));
    const button = this.button(label, action); button.className = 'project-directory-category'; button.classList.toggle('active', active); this.categoryLabel(button, label); row.append(button);
    if(action==='group:')row.dataset.crumbTarget='root';
    if(action.startsWith('favorite-group:'))row.dataset.favoriteDropTarget=action.slice(15)||'all';
    return row;
  }
  /** 用迭代栈画任意深度分类；防环只过滤重复节点，不对真实层级设上限。 */
  private appendCategoryTree(categories: HTMLElement) {
    const children = new Map<string, KnowledgeGroup[]>(), visited = new Set<string>();
    for (const group of this.groups()) { const parent = group.parent ?? ''; const siblings = children.get(parent) ?? []; siblings.push(group); children.set(parent, siblings); }
    for (const siblings of children.values()) siblings.sort((a,b) => Number(this.preferences.pinnedGroups.includes(b.id)) - Number(this.preferences.pinnedGroups.includes(a.id)));
    const stack = [...(children.get('') ?? [])].reverse().map(group => ({ group, depth: 0, top: group.id }));
    while (stack.length) {
      const { group, depth, top } = stack.pop()!;
      if (visited.has(group.id)) continue; visited.add(group.id);
      categories.append(this.categoryRow(group, depth, top, Boolean(children.get(group.id)?.length)));
      const activeDrawer = this.state.categoryView === 'drawer' && this.drawerRoot === top;
      const expanded = this.state.expandedGroups.includes(group.id) || activeDrawer && depth === 0 && !this.drawerRootCollapsed;
      if (expanded && (this.state.categoryView !== 'drawer' || activeDrawer)) {
        for (const child of [...(children.get(group.id) ?? [])].reverse()) stack.push({ group: child, depth: depth + 1, top });
      }
    }
    const unassigned = this.group('system-unassigned'); if (unassigned) categories.append(this.categoryRow(unassigned));
  }
  /** 收藏分类沿用有限缩进与抽屉规则，原集合的父级和兄弟顺序保留且不设深度上限。 */
  private appendFavoriteTree(categories: HTMLElement) {
    const all = this.preferences.favoriteCategories, byId = new Map(all.map(category => [category.id, category])), children = new Map<string, FavoriteCategory[]>();
    for (const category of all) { const parent = category.parent && category.parent !== category.id && byId.has(category.parent) ? category.parent : ''; const siblings = children.get(parent) ?? []; siblings.push(category); children.set(parent, siblings); }
    for (const siblings of children.values()) siblings.sort((a, b) => (a.order ?? all.indexOf(a)) - (b.order ?? all.indexOf(b)));
    const roots = [...children.get('') ?? []], covered = new Set<string>();
    // 异常父级或旧集合环只在显示层提供入口，不改写来源关系，也不让分类消失。
    const cover = (first: FavoriteCategory) => { const queue = [first]; while (queue.length) { const category = queue.pop()!; if (covered.has(category.id)) continue; covered.add(category.id); queue.push(...children.get(category.id) ?? []); } };
    roots.forEach(cover); for (const category of all) if (!covered.has(category.id)) { roots.push(category); cover(category); }
    const visited = new Set<string>(), stack = roots.reverse().map(category => ({ category, depth: 0, top: category.id }));
    while (stack.length) {
      const { category, depth, top } = stack.pop()!; if (visited.has(category.id)) continue; visited.add(category.id);
      categories.append(this.favoriteCategoryRow(category, depth, top, Boolean(children.get(category.id)?.length)));
      const activeDrawer = this.state.categoryView === 'drawer' && this.drawerRoot === top;
      const expanded = this.state.expandedGroups.includes(category.id) || activeDrawer && depth === 0 && !this.drawerRootCollapsed;
      if (expanded && (this.state.categoryView !== 'drawer' || activeDrawer)) for (const child of [...children.get(category.id) ?? []].reverse()) stack.push({ category: child, depth: depth + 1, top });
    }
  }
  private favoriteCategoryRow(category: FavoriteCategory, depth = 0, top = category.id, children = false) {
    const row = this.filterRow(category.label, `favorite-group:${category.id}`, this.state.favoriteGroup===category.id); row.dataset.favoriteGroup=category.id; row.dataset.topGroup = top;
    row.style.setProperty('--category-depth', String(depth)); row.setAttribute('aria-level', String(depth + 1));
    const button = row.querySelector<HTMLButtonElement>('button')!; button.style.setProperty('--directory-color', categoryColor(category.color)); button.title = [category.label, category.description].filter(Boolean).join(' · ');
    if (children) {
      const expanded = this.state.expandedGroups.includes(category.id) || this.state.categoryView === 'drawer' && this.drawerRoot === top && depth === 0 && !this.drawerRootCollapsed;
      row.setAttribute('aria-expanded', String(expanded)); button.setAttribute('aria-expanded', String(expanded));
      const arrow = this.iconButton(ChevronDown, `expand-group:${category.id}`, expanded ? '收起收藏子分类' : '展开收藏子分类'); arrow.className = 'project-directory-category-arrow'; arrow.setAttribute('aria-expanded', String(expanded)); row.append(arrow);
    }
    return row;
  }
  private categoryRow(group: KnowledgeGroup, depth = 0, top = group.id, children = false) {
    const row = document.createElement('div'); row.className = 'project-directory-category-row'; row.dataset.group = group.id; row.dataset.topGroup = top;
    row.style.setProperty('--category-depth', String(depth)); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth+1)); row.setAttribute('aria-selected', String(this.state.group===group.id));
    if (!this.snapshot!.historical && !this.options.linkOnly && group.id !== 'system-unassigned') { row.dataset.dragSource = 'group'; row.draggable = false; }
    if (row.dataset.dragSource) row.append(this.dragHandle(group.label));
    const button = this.button(group.label, `group:${group.id}`); button.className = 'project-directory-category'; button.classList.toggle('active', this.state.group === group.id);
    button.style.setProperty('--directory-color', categoryColor(group.color));
    const expanded = this.state.expandedGroups.includes(group.id) || this.state.categoryView === 'drawer' && this.drawerRoot === top && depth === 0 && !this.drawerRootCollapsed;
    if(children){button.setAttribute('aria-expanded',String(expanded));row.setAttribute('aria-expanded',String(expanded));}
    this.categoryLabel(button, group.label);
    if (this.preferences.pinnedGroups.includes(group.id)) {
      const icon = createLucideElement(Pin, { width: 11, height: 11, 'stroke-width': 1.65, 'aria-hidden': 'true' }); icon.classList.add('project-directory-category-pin'); button.querySelector('.project-directory-category-name')!.prepend(icon);
    }
    button.title = `筛选${group.label}及所有下级分类的文档${children?'；点击展开或收起子分类':''}`;
    row.append(button);
    if (children) {
      const arrow = this.iconButton(ChevronDown, `expand-group:${group.id}`, expanded ? '收起子分类' : '展开子分类');
      arrow.className = 'project-directory-category-arrow'; arrow.setAttribute('aria-expanded', String(expanded)); row.append(arrow);
    }
    return row;
  }
  private documentRow(doc: ProjectDocument, global = false) {
    const row = document.createElement('div'); row.className = 'project-directory-row'; row.dataset.id = doc.id;
    if (!this.snapshot!.historical) { row.dataset.dragSource = 'document'; row.draggable = false; row.append(this.dragHandle(doc.title)); }
    row.setAttribute('role', 'listitem');
    if ((this.options.isSelected?.(doc.id) ?? this.options.getSelected?.() === doc.id)) row.classList.add('active');
    const color = doc.color ?? this.group(doc.system)?.color ?? '#94A5BC'; row.style.setProperty('--directory-color', categoryColor(this.core(doc) ? '#CFB378' : color));
    const sections = this.snapshot!.nodes.filter(node => node.documentId === doc.id && node.kind === 'rule');
    if (sections.length) {
      const expand = this.iconButton(ChevronDown, `expand:${doc.id}`, this.expanded.has(doc.id) ? '收起章节' : '展开章节'); expand.className = 'project-directory-expand'; expand.setAttribute('aria-expanded', String(this.expanded.has(doc.id))); row.append(expand);
    }
    const select = this.button(doc.title, `select:${doc.id}`); select.className = 'project-directory-title'; select.dataset.id = doc.id; select.title = doc.title; row.append(select);
    if (!this.options.linkOnly && !this.snapshot!.historical) {
      const pinned = global || (this.preferences.categoryPins[this.pinScope()]??[]).includes(doc.id);
      const favorite = this.iconButton(Star, `favorite:${doc.id}`, this.favorite(doc.id) ? '取消收藏' : '收藏文档'); favorite.className = 'project-directory-favorite'; favorite.classList.toggle('is-favorite', this.favorite(doc.id)); favorite.setAttribute('aria-pressed', String(this.favorite(doc.id))); row.append(favorite);
      const pin = this.iconButton(global ? PinOff : Pin, `${global?'global-unpin':'pin-document'}:${doc.id}`, global ? '从总置顶区移除，保留原文档' : pinned ? '取消当前分类置顶' : '在当前分类置顶'); pin.className = 'project-directory-pin'; pin.classList.toggle('is-pinned', pinned); pin.setAttribute('aria-pressed', String(pinned)); row.append(pin);
    }
    if (this.expanded.has(doc.id) && sections.length) {
      const children = document.createElement('div'); children.className = 'project-directory-sections';
      for (const section of sections) { const child = this.button(section.title, `select:${section.id}`); child.className = 'project-directory-section'; child.title = section.title; children.append(child); }
      const wrap = document.createElement('div'); wrap.className = 'project-directory-entry'; wrap.append(row, children); return wrap;
    }
    return row;
  }
  private dragHandle(label: string) {
    const handle = document.createElement('span'); handle.className = 'project-directory-drag-handle';
    handle.append(createLucideElement(GripVertical, { width: 12, height: 14, 'stroke-width': 1.65, 'aria-hidden': 'true' }));
    handle.draggable = false; handle.title = `按住${label}约250毫秒后拖动`;
    handle.setAttribute('aria-label', handle.title); return handle;
  }

  private editor() {
    const panel = document.createElement('form'); panel.className = 'project-directory-editor'; panel.dataset.kind = this.edit!.kind;
    const doc = this.snapshot!.documents.find(item => item.id === this.edit!.id);
    const category = this.group(this.edit!.id);
    const heading = document.createElement('strong');
    if(this.edit!.kind==='favorite-category'||this.edit!.kind==='favorite-membership'||this.edit!.kind==='favorite-category-members'){
      const favoriteCategory=this.preferences.favoriteCategories.find(item=>item.id===this.edit!.id);
      const documentIds = this.edit!.documentIds ?? (doc ? [doc.id] : []);
      heading.textContent=this.edit!.kind==='favorite-membership'?`${documentIds.length > 1 ? `${documentIds.length} 份文档` : doc?.title??''} · 收藏分类`:this.edit!.kind==='favorite-category-members'?`${favoriteCategory?.label ?? ''} · 设置成员`:favoriteCategory?'修改收藏分类':'新增收藏分类';panel.append(heading);
      if(this.edit!.kind==='favorite-category'){
        const name=document.createElement('input');name.name='label';name.required=true;name.maxLength=80;name.value=favoriteCategory?.label??'';name.placeholder='例如：今日任务、昨日待讨论';name.setAttribute('aria-label','收藏分类名称');
        const color=document.createElement('input');color.name='value';color.type='color';color.value=favoriteCategory?.color??'#79B6A5';color.setAttribute('aria-label','收藏分类颜色');panel.append(name,color);
        const parentLabel = document.createElement('label'); parentLabel.textContent = '上级分类';
        const parent = document.createElement('select'); parent.name = 'parent'; parent.setAttribute('aria-label', '收藏分类的上级分类');
        const root = document.createElement('option'); root.value = ''; root.textContent = '顶层收藏分类'; parent.append(root);
        for (const item of this.preferences.favoriteCategories) {
          if (item.id === favoriteCategory?.id || favoriteCategory && favoriteCategoryAncestors(this.preferences.favoriteCategories, item.id).some(ancestor => ancestor.id === favoriteCategory.id)) continue;
          const option = document.createElement('option'); option.value = item.id; option.textContent = this.favoriteCategoryPath(item.id); parent.append(option);
        }
        parent.value = favoriteCategory ? favoriteCategory.parent ?? '' : this.preferences.favoriteCategories.some(item => item.id === this.state.favoriteGroup) ? this.state.favoriteGroup : ''; parentLabel.append(parent); panel.append(parentLabel);
        const descriptionLabel = document.createElement('label'); descriptionLabel.className = 'project-directory-description-field'; descriptionLabel.textContent = '说明';
        const description = document.createElement('textarea'); description.name = 'description'; description.rows = 3; description.value = favoriteCategory?.description ?? ''; description.placeholder = '记录整理用途、讨论要点或成员说明'; description.setAttribute('aria-label', '收藏分类说明'); descriptionLabel.append(description); panel.append(descriptionLabel);
        if (documentIds.length) { const hint = document.createElement('small'); hint.textContent = `创建后加入当前选中的 ${documentIds.length} 份文档。`; panel.append(hint); }
      }else if (this.edit!.kind === 'favorite-category-members') {
        const hint = document.createElement('small'); hint.textContent = '勾选此分类的直接成员；同一文档仍可属于其他收藏分类。'; panel.append(hint);
        const choices = document.createElement('div'); choices.className = 'project-directory-member-choices';
        const docs = this.ordered(this.snapshot!.documents.filter(item => !item.path.startsWith('docs/media/') && !['docs/README.md', 'docs/INDEX.md'].includes(item.path)));
        for (const item of docs) {
          const label = document.createElement('label'); label.title = item.title;
          const check = document.createElement('input'); check.type = 'checkbox'; check.name = 'documents'; check.value = item.id; check.checked = favoriteCategory?.documents.includes(item.id) ?? false;
          const text = document.createElement('span'); text.textContent = item.title; label.append(check, text); choices.append(label);
        }
        panel.append(choices);
        const known = new Set(docs.map(item => item.id)), retained = favoriteCategory?.documents.filter(id => !known.has(id)) ?? [];
        if (retained.length) { const notice = document.createElement('small'); notice.textContent = `另保留 ${retained.length} 个原集合引用，当前项目中无法直接显示为文档。`; notice.title = retained.join('、'); panel.append(notice); }
      }else{
        const hint=document.createElement('small');hint.textContent=documentIds.length > 1 ? '可同时加入多个分类；横线表示部分文档已加入，未改动的选项保留各自成员关系。' : '可同时加入多个收藏分类；正式文档分类保持原状。';panel.append(hint);
        const choices = document.createElement('div'); choices.className = 'project-directory-member-choices';
        for(const item of this.preferences.favoriteCategories){
          const label=document.createElement('label');label.title = this.favoriteCategoryPath(item.id);
          const check=document.createElement('input');check.type='checkbox';check.name='favoriteCategories';check.value=item.id;
          const count = documentIds.filter(id => item.documents.includes(id)).length; check.checked = count === documentIds.length; check.indeterminate = count > 0 && count < documentIds.length;
          check.dataset.mixed = String(check.indeterminate); check.addEventListener('change', () => { check.dataset.changed = 'true'; });
          const text = document.createElement('span'); text.textContent = this.favoriteCategoryPath(item.id); label.append(check,text);choices.append(label);
        }
        panel.append(choices);
        if(!this.preferences.favoriteCategories.length){const add=this.button('先创建收藏分类','new-favorite-category');panel.append(add);}
      }
      this.editorActions(panel);return panel;
    }
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
      if(this.edit!.kind==='category'&&this.edit!.id==='new'){
        const label=document.createElement('label');label.textContent='上级分类';const parent=document.createElement('select');parent.name='parent';parent.setAttribute('aria-label','新分类的上级分类');
        const root=document.createElement('option');root.value='';root.textContent='顶层分类';parent.append(root);
        for(const group of this.groups()){const option=document.createElement('option');option.value=group.id;option.textContent=`${'　'.repeat(groupAncestors(this.snapshot!,group.id).length)}${group.label}`;parent.append(option);}
        parent.value=this.group(this.state.group)?.id==='system-unassigned'?'':this.state.group;label.append(parent);panel.append(label);
      }
    } else {
      const input = document.createElement('input'); input.name = 'value'; input.required = this.edit!.kind === 'title'; input.value = this.edit!.kind === 'title' ? doc?.title ?? '' : doc ? this.aliases(doc).join('，') : ''; input.maxLength = this.edit!.kind === 'title' ? 120 : 1600; input.setAttribute('aria-label', this.edit!.kind === 'title' ? '新名称' : '别名，用逗号分隔'); panel.append(input);
      if (this.edit!.kind === 'title') { const keep = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'keepAlias'; keep.append(checkbox, document.createTextNode('旧名称保留为别名')); panel.append(keep); }
    }
    this.editorActions(panel);return panel;
  }
  /** 私人整理和公开编辑共用明确的保存、取消入口。 */
  private editorActions(panel:HTMLFormElement){
    const actions = document.createElement('div'); actions.className = 'project-directory-editor-actions';
    const cancel = this.button('取消', 'edit-cancel'); const save = document.createElement('button'); save.type = 'submit'; save.textContent = '保存'; save.disabled = this.busy; actions.append(cancel, save); panel.append(actions);
  }

  /** 四种排序均同步卡片库，图钉始终排在所选排序前面。 */
  private sortMenu(anchor:HTMLElement){
    showAppMenu((Object.entries(documentSortLabels) as [DocumentSort,string][]).map(([sort,label])=>({label:`${this.preferences.sort===sort?'✓ ':''}${label}`,run:()=>{this.preferences.sort=sort;this.savePreferences();}})),anchor);
  }
  private toggleDocumentPin(id:string){
    const scope=this.pinScope(),pins=this.preferences.categoryPins[scope]??[];
    this.preferences.categoryPins[scope]=pins.includes(id)?pins.filter(value=>value!==id):[...pins,id];this.savePreferences();
  }
  private favoriteCategoryPath(id: string) {
    return [...favoriteCategoryAncestors(this.preferences.favoriteCategories, id).map(category => category.label), this.preferences.favoriteCategories.find(category => category.id === id)?.label].filter(Boolean).join(' › ');
  }
  /** 收藏入口统一提供分类创建、说明编辑和成员整理，多选文档使用同一桥接接口。 */
  private favoriteMenu(anchor: HTMLElement) {
    const current = this.preferences.favoriteCategories.find(category => category.id === this.state.favoriteGroup);
    const selected = this.options.getSelected?.(); const ids = selected ? this.favoriteDocumentIds([selected]) : [];
    showAppMenu([
      { label: '新建收藏分类', run: () => this.addFavoriteCategory() },
      { label: '加入收藏分类…', disabled: !ids.length, reason: ids.length ? undefined : '先选择一份文档', run: () => this.chooseFavoriteCategories(ids) },
      ...(current ? [{ label: '编辑名称、颜色与说明', run: () => this.openEdit('favorite-category', current.id) }, { label: '设置分类成员…', run: () => this.openEdit('favorite-category-members', current.id) }] : []),
    ], anchor);
  }
  /** 收藏分类菜单只改变个人整理，删除分组会保留其全部收藏文档。 */
  private favoriteCategoryMenu(id:string,anchor:HTMLElement,event?:MouseEvent){
    const category = this.preferences.favoriteCategories.find(category=>category.id===id); if (!category) return;
    if (this.state.categoryView === 'drawer') this.drawerRoot = anchor.dataset.topGroup ?? favoriteCategoryAncestors(this.preferences.favoriteCategories, id)[0]?.id ?? id;
    const lifecycle = this.keepCategoryMenu();
    this.categoryMenuClose = showAppMenu([
      { label: '编辑名称、颜色与说明', run: () => this.openEdit('favorite-category', id) },
      { label: '设置分类成员…', run: () => this.openEdit('favorite-category-members', id) },
      { label: '新建下级收藏分类', run: () => { this.state.favoriteGroup = id; this.addFavoriteCategory(); } },
      { label: '删除收藏分类（保留收藏文档）', run: () => {
        // 删除父分类后把其子分类接到原父级，保持原有层级和成员可达。
        this.preferences.favoriteCategories = this.preferences.favoriteCategories.filter(item => item.id !== id).map(item => item.parent === id ? { ...item, parent: category.parent } : item);
        if (this.state.favoriteGroup === id) this.state.favoriteGroup = '';
        this.saveState(); this.savePreferences();
      } },
    ],anchor,event?{x:event.clientX,y:event.clientY}:undefined,lifecycle);
  }
  /** 文档默认菜单只有四个入口，常用收藏与图钉继续由行图标直接操作。 */
  private menu(id:string,category:boolean,anchor:HTMLElement,event?:MouseEvent){
    const entries=category?[['edit:category','修改名称与颜色'],['pin-group',this.preferences.pinnedGroups.includes(id)?'取消置顶':'置顶分类'],['group-order:-1','分类上移'],['group-order:1','分类下移'],['hierarchy:outdent','升一级'],['hierarchy:indent','降一级']]:[['preview-relations','卡片关系预览'],['edit:title','改名'],['edit:color','条目颜色']];
    if (category && this.state.categoryView === 'drawer') this.drawerRoot = anchor.dataset.topGroup ?? groupAncestors(this.snapshot!, id)[0]?.id ?? id;
    const lifecycle = category ? this.keepCategoryMenu() : undefined;
    const extra = this.options.extraCommands?.(id, category, anchor) ?? [];
    const more: AppCommand = extra.find(command => command.label.startsWith('文档更多操作')) ?? { label: '文档更多操作…', run: () => this.documentMoreMenu(id, anchor) };
    const close = showAppMenu([...entries.map(([action,label])=>({label,run:()=>{const button=this.button(label,action+':'+id);button.hidden=true;this.root.append(button);button.click();button.remove();}})),...(category ? extra : [more])],anchor,event?{x:event.clientX,y:event.clientY}:undefined,lifecycle);
    if (category) this.categoryMenuClose = close;
  }
  /** 主卡片侧栏没有工作区额外命令时，更多菜单仍提供收藏整理和明确编辑入口。 */
  private documentMoreMenu(id: string, anchor: HTMLElement) {
    showAppMenu([
      { label: '加入收藏分类…', run: () => this.chooseFavoriteCategories([id]) },
      { label: '新建收藏分类', run: () => this.addFavoriteCategory([id]) },
      { label: '管理别名', run: () => this.openEdit('aliases', id) },
      { label: '移动分类', disabled: this.snapshot!.documents.find(doc => doc.id === id)?.type === 'gdd', run: () => this.openEdit('group', id) },
    ], anchor.isConnected ? anchor : this.root);
  }
  private openEdit(kind: EditKind, id: string, documentIds?: string[]) { if (this.snapshot?.historical || this.options.linkOnly) return; this.edit = { kind, id, documentIds }; this.draw(); this.root.querySelector<HTMLInputElement>('.project-directory-editor input:not([type=checkbox]),.project-directory-editor select')?.focus(); }
  private select(id: string) {
    const doc = this.snapshot!.documents.find(item => item.id === id || this.snapshot!.nodes.some(node => node.id === id && node.documentId === item.id));
    if (doc) this.remember(doc.id);
    this.options.onSelect(id); this.draw();
  }
  /** 首次单击会重绘目录，因此同时识别标题的连续两次单击以保证双击稳定。 */
  private openDocument(id: string) {
    const at = performance.now();
    if (this.lastOpenedDocument?.id === id && at - this.lastOpenedDocument.at < 100) return;
    this.lastOpenedDocument = { id, at }; this.lastTitleClick = undefined;
    window.dispatchEvent(new CustomEvent('cewen:read-document', { detail: id }));
  }
  /** 抽屉自动展开的根分类也响应显式收起，避免下箭头看似可点却没有变化。 */
  private toggleGroupExpanded(id: string) {
    const autoDrawer = this.state.categoryView === 'drawer' && this.drawerRoot === id;
    const expanded = this.state.expandedGroups.includes(id) || autoDrawer && !this.drawerRootCollapsed;
    this.state.expandedGroups = expanded ? this.state.expandedGroups.filter(value => value !== id) : [...this.state.expandedGroups, id];
    if (autoDrawer) this.drawerRootCollapsed = expanded;
  }

  private click = (event: MouseEvent) => {
    // 长按松开时浏览器可能补发单击；不把已确认拖动的动作当作文档选择。
    if (this.suppressClick && (event.target as HTMLElement).closest('[data-drag-source]')) { this.suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]'); if (!button) return;
    event.stopPropagation();
    const action = button.dataset.action!;
    if (!action.startsWith('select:')) this.lastTitleClick = undefined;
    if (action === 'category-view') { this.categoryViewMenu(button); return; }
    if (action.startsWith('expand-group:')) {
      this.toggleGroupExpanded(action.slice(13));
      this.saveState(); this.draw(); return;
    }
    if(action.startsWith('open-document:')){window.dispatchEvent(new CustomEvent('cewen:read-document',{detail:action.slice(14)}));return;}
    if(action.startsWith('preview-relations:')){window.dispatchEvent(new CustomEvent('cewen:relation-preview',{detail:action.slice(18)}));return;}
    if (action.startsWith('tab:')) {
      this.rememberScroll();this.state.tab=action.slice(4) as DirectoryTab;this.query='';this.options.onQuery?.('');
      if(this.state.tab!=='documents'){this.state.group='';this.state.favoriteGroup='';this.options.onGroup('');}
      this.saveState();this.draw();return;
    }
    if (action.startsWith('group:')) {
      this.rememberScroll(); this.state.group = action.slice(6);
      const id=this.state.group;
      if (this.state.categoryView === 'drawer' && id) this.drawerRoot = groupAncestors(this.snapshot!, id)[0]?.id ?? id;
      if(this.groups().some(group=>group.parent===id))this.toggleGroupExpanded(id);
      this.state.tab='documents';this.options.onGroup(id);this.saveState();this.draw();return;
    }
    if(action.startsWith('favorite-group:')){
      this.rememberScroll();this.state.favoriteGroup=action.slice(15); const id = this.state.favoriteGroup;
      if (id && this.state.categoryView === 'drawer') this.drawerRoot = favoriteCategoryAncestors(this.preferences.favoriteCategories, id)[0]?.id ?? id;
      if (this.preferences.favoriteCategories.some(category => category.parent === id)) this.toggleGroupExpanded(id);
      this.saveState();this.draw();return;
    }
    if(action==='sort'){this.sortMenu(button);return;}
    if(action==='favorite-menu'){this.favoriteMenu(button);return;}
    if (action.startsWith('select:')) {
      const id = action.slice(7);
      if (button.classList.contains('project-directory-title') && !this.options.linkOnly) {
        const at = performance.now();
        if (this.lastTitleClick?.id === id && at - this.lastTitleClick.at < 350) { this.openDocument(id); return; }
        this.lastTitleClick = { id, at };
      }
      if(this.options.onSelectEvent?.(id,event))return;
      this.select(id); return;
    }
    if (action.startsWith('expand:')) { const id = action.slice(7); this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); this.draw(); return; }
    if(action.startsWith('favorite:')){this.toggleFavorite(action.slice(9));return;}
    if (this.options.linkOnly && !action.startsWith('select:')) return;
    if (action.startsWith('menu:')) { this.menu(action.slice(5), false, button); return; }
    if (action.startsWith('category-menu:')) { this.menu(action.slice(14), true, button); return; }
    if (action === 'new-category') { this.openEdit('category', 'new'); return; }
    if(action==='new-favorite-category'){this.addFavoriteCategory(this.edit?.documentIds);return;}
    if(action.startsWith('favorite-membership:')){this.chooseFavoriteCategories([action.slice(20)]);return;}
    if(action.startsWith('pin-document:')){this.toggleDocumentPin(action.slice(13));return;}
    if(action.startsWith('global-pin:')){this.preferences.globalPins=[...new Set([...this.preferences.globalPins,action.slice(11)])];this.savePreferences();return;}
    if(action.startsWith('global-unpin:')){this.preferences.globalPins=this.preferences.globalPins.filter(id=>id!==action.slice(13));this.savePreferences();return;}
    if (action === 'edit-cancel') { this.edit = undefined; this.draw(); return; }
    if (action.startsWith('edit:')) { const [, kind, id] = action.split(':'); this.openEdit(kind as EditKind, id); return; }
    if (action.startsWith('pin-group:')) { const id = action.slice(10); this.preferences.pinnedGroups = this.preferences.pinnedGroups.includes(id) ? this.preferences.pinnedGroups.filter(value => value !== id) : [...this.preferences.pinnedGroups, id]; this.savePreferences(); return; }
    if (action.startsWith('group-order:')) { const [, direction, id] = action.split(':'); void this.reorderGroup(id, Number(direction)); return; }
    if (action.startsWith('hierarchy:')) { const [, movement, id] = action.split(':'); void this.changeLevel(id, movement as 'indent' | 'outdent'); return; }
    if (action.startsWith('order:')) { const [, direction, id] = action.split(':'); void this.reorder(id, Number(direction)); }
  };
  /** 双击文档进入策划案画布；改名仍由明确菜单或 F2 执行。 */
  private doubleClick = (event: MouseEvent) => { const title = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-title'); if (title?.dataset.id && !this.options.linkOnly) { event.preventDefault(); event.stopPropagation(); this.openDocument(title.dataset.id); } };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.edit) { this.edit = undefined; this.draw(); return; }
    if((event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')&&!this.options.linkOnly){const row=(event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row');if(row?.dataset.favoriteGroup){event.preventDefault();this.favoriteCategoryMenu(row.dataset.favoriteGroup,row);return;}const id=row?.dataset.id??row?.dataset.group;if(row&&id){event.preventDefault();this.menu(id,!!row.dataset.group,row);}return;}
    const categoryRow = (event.target as HTMLElement).closest<HTMLElement>('[data-group],[data-favorite-group]');
    const category=categoryRow?.dataset.group ?? categoryRow?.dataset.favoriteGroup;
    if(category&&['ArrowLeft','ArrowRight'].includes(event.key)){
      if (this.state.categoryView === 'drawer') this.drawerRoot = categoryRow?.dataset.topGroup ?? category;
      event.preventDefault();const open=this.state.expandedGroups.includes(category) || this.state.categoryView === 'drawer' && this.drawerRoot === category && !this.drawerRootCollapsed;
      if(event.key==='ArrowRight'&&!open)this.toggleGroupExpanded(category);
      if(event.key==='ArrowLeft'&&open)this.toggleGroupExpanded(category);
      this.saveState();this.draw();return;
    }
    if (event.key !== 'F2' || this.options.linkOnly) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row');
    if (row?.dataset.id) { event.preventDefault(); this.openEdit('title', row.dataset.id); }
  };
  private input = (event: Event) => { if ((event.target as HTMLElement).dataset.role === 'search') { this.query = (event.target as HTMLInputElement).value; this.options.onQuery?.(this.query); this.draw(); } };

  private async commit(reason: string, changes: FileChange[]) {
    if (!changes.length || this.busy) return false;
    const snapshot = this.snapshot!;
    if (snapshot.historical || this.options.linkOnly) throw new Error('当前目录只读，请返回项目工作稿。');
    this.busy = true; this.draw();
    try {
      const updated = this.options.onStage ? await this.options.onStage(reason,changes) : await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, actor: 'user', reason, changes });
      this.snapshot = updated; this.options.onCommit(updated); this.edit = undefined; this.draw();
      return true;
    } catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); return false; }
    finally { this.busy = false; this.draw(); }
  }
  private categoryChanges(groups: KnowledgeGroup[]): FileChange[] {
    const snapshot = this.snapshot!;
    if (!snapshot.projectEntry) throw new Error('项目入口尚未就绪，无法修改分类。');
    return [{ path: 'PROJECT.md', baseHash: snapshot.projectEntry.hash, text: setMetadata(snapshot.projectEntry.text, { minimumAppVersion: readHeader(snapshot.projectEntry.text).metadata.minimumAppVersion ?? '0.7.0', systems: groups.map(group => ({ id: group.id, title: group.label, color: group.color, ...(group.parent ? { parent: group.parent } : {}) })) }) },
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
    if(kind==='favorite-category'){
      const label=String(data.get('label')??'').trim();if(!label||!validColor(value))return;
      const parent = String(data.get('parent') ?? ''), description = String(data.get('description') ?? '');
      if(parent && (!this.preferences.favoriteCategories.some(category => category.id === parent) || parent === id || favoriteCategoryAncestors(this.preferences.favoriteCategories, parent).some(category => category.id === id))){this.options.onError('请选择有效的上级收藏分类，不能形成循环。');return;}
      if(this.preferences.favoriteCategories.some(category=>category.id!==id&&category.label===label&&(category.parent ?? '')===parent)){this.options.onError('同一上级下已有同名收藏分类。');return;}
      if(id==='new') {
        const documents = this.favoriteDocumentIds(this.edit.documentIds ?? []), categoryId = `favorite-${crypto.randomUUID()}`;
        this.preferences.favoriteCategories.push({id:categoryId,label,color:value,documents,parent:parent || undefined,description});
        this.preferences.favorites = [...new Set([...this.preferences.favorites, ...documents])]; this.state.favoriteGroup = categoryId;
      } else this.preferences.favoriteCategories=this.preferences.favoriteCategories.map(category=>category.id===id?{...category,label,color:value,parent:parent || undefined,description}:category);
      if (parent) this.state.expandedGroups = [...new Set([...this.state.expandedGroups, parent, ...favoriteCategoryAncestors(this.preferences.favoriteCategories, parent).map(category => category.id)])];
      this.edit=undefined;this.saveState();this.savePreferences();return;
    }
    if(kind==='favorite-membership'){
      const documentIds = this.favoriteDocumentIds(this.edit.documentIds ?? [id]); if (!documentIds.length) return;
      for(const check of event.target.querySelectorAll<HTMLInputElement>('input[name=favoriteCategories]')) {
        // 未调整的混合选项保持每份文档原关系；明确勾选或取消才批量应用。
        if (check.dataset.mixed === 'true' && !check.dataset.changed) continue;
        const category = this.preferences.favoriteCategories.find(item => item.id === check.value); if (!category) continue;
        category.documents = check.checked ? [...new Set([...category.documents, ...documentIds])] : category.documents.filter(value => !documentIds.includes(value));
      }
      this.preferences.favorites = [...new Set([...this.preferences.favorites, ...documentIds])];
      this.edit=undefined;this.savePreferences();return;
    }
    if (kind === 'favorite-category-members') {
      const category = this.preferences.favoriteCategories.find(item => item.id === id); if (!category) return;
      const shown = new Set([...event.target.querySelectorAll<HTMLInputElement>('input[name=documents]')].map(check => check.value));
      const chosen = data.getAll('documents').map(String);
      // 原集合中当前不可识别的引用独立保留，设置文档成员不会丢失它们。
      category.documents = [...new Set([...category.documents.filter(value => !shown.has(value)), ...chosen])];
      this.preferences.favorites = [...new Set([...this.preferences.favorites, ...chosen])];
      this.edit = undefined; this.savePreferences(); return;
    }
    if (kind === 'category') {
      const label = String(data.get('label') ?? '').trim(); if (!label || !validColor(value)) return;
      if (this.snapshot!.groups.some(group => group.id !== id && group.label === label)) { this.options.onError('已有同名分类。'); return; }
      const parent=String(data.get('parent')??'');
      if(parent&&!this.group(parent)){this.options.onError('上级分类已不存在，请重新选择。');return;}
      if(parent)this.state.expandedGroups=[...new Set([...this.state.expandedGroups,parent])];
      const groups = id === 'new' ? [...this.groups(), { id: `system-${crypto.randomUUID()}`, label, color: value, ...(parent ? { parent } : {}) }] : this.groups().map(group => group.id === id ? { ...group, label, color: value } : group);
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
    const ordered = this.visibleDocuments();
    const index = ordered.findIndex(item => item.id === id), other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    await this.reorderDocumentList(id, ordered[other].id, direction < 0 ? 'before' : 'after');
  }
  /** 列表汇总了不同层级，手工排序只改公开身份数组，不能顺便改变父文档或分类。 */
  private async reorderDocumentList(id:string,targetId:string,placement:'before'|'after'){
    const snapshot=this.snapshot!,entry=snapshot.projectEntry;if(!entry||id===targetId||snapshot.historical||this.options.linkOnly||this.busy)return;
    const docs=snapshot.documents.filter(doc=>!doc.id.startsWith('unidentified:'));
    if(!docs.some(doc=>doc.id===id)||!docs.some(doc=>doc.id===targetId))return;
    // 首次拖动从用户当前看到的顺序起步，避免其他排序切到用户顺序时整列跳动。
    const list=sortDocuments(snapshot,docs,this.preferences.sort).map(doc=>doc.id).filter(value=>value!==id);
    const at=list.indexOf(targetId);if(at<0)return;list.splice(at+(placement==='after'?1:0),0,id);
    const updated=await this.commit('调整文档展示顺序',[{path:'PROJECT.md',baseHash:entry.hash,text:setMetadata(entry.text,{documentListOrder:list})}]);
    if(updated){
      const pins=this.preferences.categoryPins[this.pinScope()]??[];
      if(pins.includes(id)&&pins.includes(targetId)){const next=pins.filter(value=>value!==id),position=next.indexOf(targetId);next.splice(position+(placement==='after'?1:0),0,id);this.preferences.categoryPins[this.pinScope()]=next;}
      this.preferences.sort='manual';this.savePreferences();
    }
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
      const grandparent = group ? this.group(parentId)?.parent ?? getRootDocumentId(this.snapshot!) ?? 'root' : this.group(parentId) ? this.group(parentId)?.parent : effectiveDocumentParent(this.snapshot!, parentId)?.id;
      if (grandparent) await this.move(kind, id, grandparent, 'inside');
      return;
    }
    const siblings = group ? this.groups().filter(item => (item.parent ?? '') === (group.parent ?? '')) : this.ordered(this.snapshot!.documents.filter(item => effectiveDocumentParent(this.snapshot!, item.id)?.id === effectiveDocumentParent(this.snapshot!, id)?.id && !this.core(item)),true);
    const index = siblings.findIndex(item => item.id === id);
    if (index > 0) await this.move(kind, id, siblings[index - 1].id, 'inside');
  }
  /** 按下时预备原生拖动候选，长按确认后才显示手柄并允许 dragstart。 */
  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.pointerUp(); this.suppressClick = false;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-source]');
    if (!row || (event.target as HTMLElement).closest('button:not(.project-directory-title):not(.project-directory-category)')) return;
    this.pressed = row;
    // Chromium 在 mousedown 默认动作中确定拖动候选；必须先在 pointerdown 中预备。
    // 手柄仍隐藏，快速移动会取消预备，dragstart 也继续要求长按确认。
    row.draggable = true;
    this.pressStart = { x: event.clientX, y: event.clientY };
    this.longPress = window.setTimeout(() => {
      if (this.pressed !== row || !row.isConnected) return;
      row.classList.add('drag-ready'); row.draggable = true; this.suppressClick = true;
      // 接收区在长按确认时先完成布局；dragstart 阶段不再挪动原生拖动源的位置。
      this.root.classList.toggle('is-dragging-document', row.dataset.dragSource === 'document');
      const handle = row.querySelector<HTMLElement>('.project-directory-drag-handle'); if (handle) handle.draggable = true;
    }, 250);
  };
  private pointerMove = (event: PointerEvent) => { if (this.pressStart && Math.hypot(event.clientX - this.pressStart.x, event.clientY - this.pressStart.y) > 8 && !this.pressed?.classList.contains('drag-ready')) this.pointerUp(); };
  private pointerUp = () => {
    if (this.longPress) window.clearTimeout(this.longPress); this.longPress = undefined;
    if (this.dragging) return;
    this.root.classList.remove('is-dragging-document');
    if (this.pressed) { this.pressed.classList.remove('drag-ready'); this.pressed.draggable = false; const handle = this.pressed.querySelector<HTMLElement>('.project-directory-drag-handle'); if (handle) handle.draggable = false; }
    this.pressed = undefined; this.pressStart = undefined;
  };
  private dragStart = (event: DragEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-source]');
    if (!row || this.snapshot?.historical || !row.classList.contains('drag-ready')) { event.preventDefault(); return; }
    const kind = row.dataset.dragSource as 'group' | 'document';
    const id = kind === 'group' ? row.dataset.group : row.dataset.id;
    if (!id) { event.preventDefault(); return; }
    this.dragging = { kind, id };
    // 空接收区已在长按确认阶段展开，此处只记录身份，避免拖动建立过程中触发布局变化。
    this.updateCategoryLayout();
    if (kind === 'document') {
      const doc = this.snapshot!.documents.find(item => item.id === id)!;
      const payload = { projectId: this.snapshot!.project.id, documentId: id, path: doc.path, title: doc.title };
      this.dragDocument = payload;
      event.dataTransfer?.setData('application/x-cewen-document', JSON.stringify(payload));
      event.dataTransfer?.setData('text/plain', doc.title);
      window.dispatchEvent(new CustomEvent('cewen:document-drag-start', { detail: payload }));
    } else event.dataTransfer?.setData('text/plain', this.group(id)?.label ?? '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = this.options.linkOnly ? 'copy' : 'copyMove';
    this.pointerUp();
  };
  private dropTarget(event: DragEvent):DirectoryDropTarget|undefined {
    if(!this.dragging||this.options.linkOnly)return;
    const origin=event.target as HTMLElement;
    const global=origin.closest<HTMLElement>('[data-global-pins]');
    if(global){
      if(this.dragging.kind!=='document')return;
      const row=origin.closest<HTMLElement>('.project-directory-row'),rect=row?.getBoundingClientRect();
      return {element:global,targetId:row?.dataset.id??'',placement:rect&&event.clientY>rect.top+rect.height/2?'after':'before',mode:'global'};
    }
    const favorite=origin.closest<HTMLElement>('[data-favorite-drop-target]');
    if(favorite&&this.dragging.kind==='document')return {element:favorite,targetId:favorite.dataset.favoriteDropTarget!,placement:'inside',mode:'favorite'};
    const element = (event.target as HTMLElement).closest<HTMLElement>('.project-directory-row,.project-directory-category-row,.project-directory-crumb');
    if (!element || !this.dragging || this.options.linkOnly) return;
    const kind = element.dataset.group ? 'group' : element.dataset.id ? 'document' : 'crumb';
    const targetId = element.dataset.group ?? element.dataset.id ?? element.dataset.crumbTarget;
    if (!targetId || targetId === this.dragging.id) return;
    // 文档区内的拖放只有前后排序；改层级必须放到分类或使用明确菜单命令。
    if(kind==='document'&&this.dragging.kind==='document'&&element.closest('.project-directory-items')){
      const rect=element.getBoundingClientRect();
      return {element,targetId,placement:event.clientY<rect.top+rect.height/2?'before':'after',mode:'order'};
    }
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
    // 无总纲的通用项目仍可通过分类路径拖回顶层。
    const resolvedId = targetId === 'root' ? getRootDocumentId(this.snapshot!) ?? 'root' : targetId;
    if (!resolvedId) return;
    if(this.dragging.kind==='document'&&this.core(this.snapshot!.documents.find(doc=>doc.id===this.dragging!.id)!))return;
    return { element, targetId: resolvedId, placement: placement as 'before' | 'after' | 'inside', mode:'hierarchy' };
  }
  private clearDrop() { this.root.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach(item => item.classList.remove('drop-before', 'drop-after', 'drop-inside')); }
  private dragOver = (event: DragEvent) => {
    const target = this.dropTarget(event); if (!target || !this.dragging || this.snapshot?.historical) return;
    event.preventDefault(); this.clearDrop(); target.element.classList.add(`drop-${target.placement}`);
    target.element.title = target.mode==='global'?'加入总置顶，文档保留在原分类':target.mode==='favorite'?'加入此收藏分类':target.placement === 'inside' ? '放入此层级' : target.placement === 'before' ? '放在前面' : '放在后面';
    if (event.dataTransfer) event.dataTransfer.dropEffect = target.mode==='global'||target.mode==='favorite'?'copy':'move';
  };
  private dragLeave = (event: DragEvent) => { if (!this.root.contains(event.relatedTarget as Node)) this.clearDrop(); };
  private drop = (event: DragEvent) => {
    const target = this.dropTarget(event), source = this.dragging; this.clearDrop();
    if (!target || !source || this.snapshot?.historical || this.options.linkOnly) return;
    event.preventDefault(); event.stopPropagation();
    this.dragEnd();
    if(target.mode==='global'){
      const pins=this.preferences.globalPins.filter(id=>id!==source.id),at=pins.indexOf(target.targetId);
      pins.splice(at<0?pins.length:at+(target.placement==='after'?1:0),0,source.id);this.preferences.globalPins=pins;this.savePreferences();return;
    }
    if(target.mode==='favorite'){
      if(!this.favorite(source.id))this.preferences.favorites.push(source.id);
      if(target.targetId==='unfiled')for(const category of this.preferences.favoriteCategories)category.documents=category.documents.filter(id=>id!==source.id);
      else{const category=this.preferences.favoriteCategories.find(item=>item.id===target.targetId);if(category&&!category.documents.includes(source.id))category.documents.push(source.id);}
      this.savePreferences();return;
    }
    if(target.mode==='order'){void this.reorderDocumentList(source.id,target.targetId,target.placement==='after'?'after':'before');return;}
    void this.move(source.kind, source.id, target.targetId, target.placement);
  };
  private dragEnd = () => {
    if (this.dragDocument) window.dispatchEvent(new CustomEvent('cewen:document-drag-end', { detail: this.dragDocument }));
    this.dragDocument = undefined; this.dragging = undefined; this.clearDrop(); this.pointerUp();
    // 冻结期间没有修改分类悬停，结束后按实际指针位置恢复分类栏。
    this.categoryHover = this.root.querySelector('.project-directory-categories')?.matches(':hover') ?? false;
    if (!this.categoryHover && !this.categoryMenuOpen) { this.drawerRoot = ''; this.hoverCategory = ''; }
    this.updateCategoryLayout();
  };

  dispose() {
    // 引用目录可能在拖动途中关闭；必须对称结束事件并清除长按计时器。
    this.dragEnd();
    this.categoryMenuClose?.();
    this.root.removeEventListener('click', this.click); this.root.removeEventListener('dblclick', this.doubleClick);
    this.root.removeEventListener('keydown', this.keydown); this.root.removeEventListener('input', this.input); this.root.removeEventListener('submit', this.submit);
    this.root.removeEventListener('dragstart', this.dragStart); this.root.removeEventListener('dragover', this.dragOver); this.root.removeEventListener('dragleave', this.dragLeave); this.root.removeEventListener('drop', this.drop); this.root.removeEventListener('dragend', this.dragEnd);
    this.root.removeEventListener('pointerdown', this.pointerDown); this.root.removeEventListener('pointermove', this.pointerMove); this.root.removeEventListener('pointerup', this.pointerUp); this.root.removeEventListener('pointercancel', this.pointerUp);
    window.removeEventListener('pointerup', this.pointerUp); window.removeEventListener('pointercancel', this.pointerUp);
    window.removeEventListener('cewen:document-list-change',this.preferencesChanged);
    this.root.remove();
  }
}
