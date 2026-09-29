import { showAppMenu } from './app-menu';
import { initializeBrowseHistory, historyScope, recordVisit } from './browse-history';
import { initializeContextGestures } from './context-gesture';
import { shortcutAction,openInputSettings,initializeInputBindings } from './input-settings';
import { DocumentDesktop } from './document-desktop';
import { isTransientProject } from '../shared/transient';
let documentDesktop:DocumentDesktop|undefined;
import './creative/creative.css';
import { CreativeWorkspace } from './creative/workspace';
import { openPresetDialog } from './creative/preset-dialog';
import { openExampleHub } from './examples/example-hub';
import './style.css';
import './workbench.css';
import './features.css';
import './theme.css';
import './shell.css';
import './authoring.css';
import './creation-editing.css';
import './workspace-060.css';
import './workspace-070.css';
import './card-library.css';
import './task-dialogs.css';
import { installIconInteractions } from './icon-interaction';
import { groupAncestors } from '../shared/project-hierarchy';
import { documentNameOrder, documentSortLabels, sortDocuments, type DocumentSort } from '../shared/document-order';
import { documentPinScope, readDocumentListState, saveDocumentListState } from './document-list-state';
import { setNotebookTexture } from './notebook-style';
import { openProjectDetails, projectIdentity } from './project-details';
import { openContentOverview } from './content-overview';
import { ProjectDirectory } from './project-directory';
import { mountDocumentPresentation } from './document-presentation';
import { EditingSession } from './editing-session';
import { graphChanges } from '../shared/graph-editing';
import { projectWorkView } from '../shared/collaboration';
import { parseKnowledge } from '../shared/markdown';
import type { GraphEdit } from '../shared/graph-editing';
import { chooseAction, chooseRelationType, classifyDocuments, connectDocuments, editEdge } from './relation-editing';
import { categoryColor } from './category-color';
import { openCollaboration } from './prompt-panel';
import { initializeTheme, mountDesktopChrome } from './theme';
import { createIcons, Orbit, Network, Layers, FileText, LayoutGrid, Search, ChevronRight, ChevronLeft, ArrowUpDown, ArrowUpRight, X, Focus, Plus, Minus, Sparkles, ArrowLeft, CircleDot, PanelLeft } from 'lucide';
import { KnowledgeGraph, type GraphMode, type GraphDirection } from './graph';
import { nodes, edges, groups, types, setKnowledgeData, type KnowledgeNode, type ProjectSnapshot } from './data';
import { edgeSentence } from './analysis';
import { projectAction, connectProjects, readProject, subscribeProjectEvents } from './project-client';
import { beginProjectLoading, currentProjectLoading, type ProjectLoadingTask } from './project-loading';
import { ProjectWorkbench } from './workbench';
import { HistoryPanel } from './history-panel';
import { WorkspacePanel } from './workspace-panel';
import { CollaborationPanel } from './collaboration-panel';
import { projectMarkdown, installReadingPreviews } from './document-reading';
import { initializeConnectorPanel, onConnectorProject, setConnectorTakeoverGuard } from './connector-panel';
import type { ConnectorSession } from '../browser/connector';
import { ConnectionPanel } from './connection-panel';
import { isWebEdition } from './edition';
import { TutorialManager } from './tutorial/tutorial-manager';
import { designformTutorials,setTutorialProject,setPracticeProject,isPracticeProject } from './tutorial/tutorials';

/** 启动时读取独立项目目录；没有最近项目则进入项目中心，不自动接入真实资料。 */
let projectSnapshot: ProjectSnapshot | undefined;
initializeBrowseHistory();initializeContextGestures();initializeInputBindings();
document.addEventListener('keydown',event=>{if(!event.defaultPrevented&&!document.querySelector('dialog:modal')&&shortcutAction(event)==='settings'){event.preventDefault();void openInputSettings();}},{capture:true});

/** 项目订阅随项目切换释放；事件与轮询共享正式快照刷新。 */
let liveProject='',disposeLive:(()=>void)|undefined,liveRefreshing=false;
async function refreshLive(){if(liveRefreshing||!projectSnapshot||projectSnapshot.historical)return;const id=projectSnapshot.project.id;liveRefreshing=true;try{const next=await readProject(id);if(projectSnapshot?.project.id===id)applyProject(next);}catch(error){reportProjectError(error);}finally{liveRefreshing=false;}}
function syncLive(snapshot:ProjectSnapshot){const id=snapshot.historical||isTransientProject(snapshot.project.id)?'':snapshot.project.id;if(id===liveProject)return;disposeLive?.();disposeLive=undefined;liveProject=id;if(id)disposeLive=subscribeProjectEvents(id,()=>void refreshLive());}
setInterval(()=>{if(!document.hidden&&liveProject)void refreshLive();},6000);
let connectionError = '';
/** URL 项目读取到工作台显示沿用同一任务，初始化失败或取消时立即释放。 */
let startupLoading: ProjectLoadingTask | undefined;
try {
  const linkedProject = new URL(location.href).searchParams.get('project');
  if(linkedProject){startupLoading=currentProjectLoading()??beginProjectLoading('链接中的项目');await startupLoading?.paint();startupLoading?.throwIfCancelled();}
  const library = startupLoading ? await startupLoading.wait(connectProjects()) : await connectProjects();
  const linked = library.projects.find(project => project.id === linkedProject);
  if(linked){
    startupLoading?.setTitle(linked.name);
    projectSnapshot=startupLoading?await startupLoading.wait(readProject(linked.id)):await readProject(linked.id);
    startupLoading?.throwIfCancelled();startupLoading?.setCancellable(false);
    startupLoading?.stage('categories',`${projectSnapshot.groups.length} 个分类 · ${projectSnapshot.documents.length} 份文档`);await startupLoading?.paint();
  }
  // 默认进入项目库，不自动读取上次项目。
  if (projectSnapshot) setKnowledgeData(projectSnapshot);
  else{startupLoading?.finish();startupLoading=undefined;}
} catch (error) {
  if(!startupLoading?.signal.aborted)connectionError=error instanceof Error?error.message:'本地项目服务暂不可用。';
  projectSnapshot=undefined;startupLoading?.finish();startupLoading=undefined;
}

/** 阅读状态与文档编辑数据分开，不把镜头与筛选写入策划正文。 */
type View = 'graph' | 'document' | 'cards' | 'creative' | 'quest' | 'animatic';
type OverviewMode = Exclude<GraphMode, 'network'>;
/** 分析是知识空间内的次级阅读页，返回时恢复进入前的选择及筛选。 */
type AnalysisOrigin = { mode: OverviewMode; selected: string | null; group: string | null; query: string; directOnly: boolean };
let analysisOrigin: AnalysisOrigin | null = null;
let overviewMode: OverviewMode = 'galaxy';
const state = { view: 'graph' as View, mode: 'galaxy' as GraphMode, direction: 'vertical' as GraphDirection, selected: null as string | null, relationIndex: null as number | null, group: null as string | null, query: '', directOnly: false, labelsAll: false, paused: false, scopeIds: null as string[] | null, includeArchived: false, detailedGraph: false };
const nodeById = new Map(nodes.map(node => [node.id, node]));
const app = document.getElementById('app')!;
const closeReadingPreview = installReadingPreviews(() => projectSnapshot);
/** 来源定位依赖稳定身份或唯一摘录；歧义不跳到猜测段落。 */
window.addEventListener('cewen:locate-anchor',event=>{
 const {anchor,resolved}=(event as CustomEvent<{anchor:{excerpt?:string};resolved:{documentId:string;objectId?:string;blockId?:string;state:string}}>).detail;
 if(['missing','ambiguous'].includes(resolved.state))return;
 if(resolved.objectId){window.dispatchEvent(new CustomEvent('cewen:creative-request',{detail:{action:'object',objectId:resolved.objectId}}));return;}
 window.dispatchEvent(new CustomEvent('cewen:read-document',{detail:resolved.documentId}));
 requestAnimationFrame(()=>{const article=document.getElementById('doc-'+resolved.documentId);if(!article)return;
 const quote=anchor.excerpt?.trim();const blocks=Array.from(article.querySelectorAll<HTMLElement>('p,li,h2,h3,h4,blockquote'));const matches=quote?blocks.filter(el=>el.textContent?.includes(quote)):[];const target=matches.length===1?matches[0]:article;
 target.scrollIntoView({block:'center',behavior:'instant'});target.tabIndex=-1;target.focus({preventScroll:true});get('announcement').textContent=matches.length===1?'已定位唯一来源摘录。':'已打开来源文档；正文重排后可按摘录核对。';
 });
});
window.addEventListener('cewen:read-document', event => {
  const id = (event as CustomEvent<string>).detail; if(documentDesktop&&!projectSnapshot?.historical){documentDesktop.openDocument(id,true);return;} if (!nodeById.has(id)) return;
  state.scopeIds = null; selectNode(id); setView('document');
  const node = nodeById.get(id)!;
  const anchor = node.anchor && get('reading-view').querySelector(`#doc-${CSS.escape(node.documentId)} [id="${CSS.escape(node.anchor)}"]`);
  if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'instant' }); else get('reading-view').scrollTop = 0;
});
/** 阅读回退只保存当前阅读位置，不写入策划正文或版本。 */
const readingTrail: { selected: string | null; scroll: number; group: string | null; scopeIds: string[] | null; query: string }[] = [];
const names = { galaxy: '星图总览', network: '脑图聚焦', layers: '系统分层', mindmap: '设计脑图' };
const kindNames = { system: '系统', document: '专项文档', rule: '设计规则' };
const statusNames = { confirmed: '已确认', draft: '草稿', question: '待确认', archived: '已归档' };
const icons = { Orbit, Network, Layers, FileText, LayoutGrid, Search, ChevronRight, ChevronLeft, ArrowUpDown, ArrowUpRight, X, Focus, Plus, Minus, Sparkles, ArrowLeft, CircleDot, PanelLeft };

/** 所有来自资料的数据进入 HTML 前转义，后续接入导入功能时也不执行文档中的标签。 */
function escape(text: string) { return text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!)); }
function icon(name: string) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }
function refreshIcons() { createIcons({ icons, attrs: { 'stroke-width': 1.65 } }); }
function sourceName(source: string) { return source.split('/').at(-1) || source; }
function groupOf(node: KnowledgeNode) { return groups.find(group => group.id === node.group) ?? {id:'',label:node.documentType==='gdd'?'游戏总纲':'未归组',color:'#CFB378'}; }
function status(node: KnowledgeNode) { return `<span class="status ${node.status}">${statusNames[node.status]}</span>`; }

/** 固定的工作台框架只创建一次，切换模式保留同一个 WebGL 画布。 */
app.innerHTML = `
  <header class="application-bar" aria-label="策问应用功能">
    <button class="brand" type="button" aria-label="策问：进入项目问题模式"><span class="brand-name">策问</span><small class="brand-wordmark">Designform</small></button>
    <span class="application-divider"></span><button class="application-projects" id="project-center">${icon('layout-grid')}项目库</button>
    <span class="application-tagline">把想法写成游戏</span>
    <div class="application-actions"><button class="tutorial-help icon-button" id="tutorial-help" data-tutorial="tutorial-help" aria-label="新手教程" title="新手教程">?</button><button class="llm-connection" id="llm-connection" data-tutorial="llm-connection" aria-label="LLM 连接状态"><span class="connection-dot"></span><span><strong>正在检查连接</strong><small>LLM 协作</small></span></button><button class="theme-toggle icon-button" data-theme-toggle aria-label="切换浅色主题"></button></div>
  </header>
  <button class="sidebar-scrim" id="sidebar-scrim" aria-label="收起项目目录"></button>
  <aside class="sidebar" id="project-sidebar" aria-label="当前项目文档目录">
    <button class="icon-button sidebar-close" id="sidebar-close" aria-label="收起项目面板" title="收起项目面板">${icon('panel-left')}</button>
    <div class="project-label">当前项目</div>
    <button class="project project-opener" id="project-switch" data-tutorial="project-switch" aria-label="当前项目设置"><span class="project-art">${icon('file-text')}</span><span><strong id="project-name">${escape(projectSnapshot?.project.name ?? '选择项目')}</strong><small id="project-description">${projectSnapshot?.project.isExample ? '虚构基础示例' : '独立文档 · 本地保存'}</small></span>${icon('chevron-right')}</button>
    <label class="search-box" data-tutorial="search">${icon('search')}<input id="search" type="search" placeholder="搜索标题、规则…" autocomplete="off" aria-label="搜索策划内容"/><kbd>/</kbd></label>
    <details class="system-filter"><summary><span id="system-filter-label">全部系统</span><small><span id="system-count">${groups.length}</span> 个系统</small></summary>
    <div class="system-list">
      <button data-group="" class="group-button active"><span class="all-systems">${icon('circle-dot')}</span><span>全部系统</span><small>${nodes.length}</small></button>
      ${groups.map(group => `<button class="group-button" data-group="${group.id}"><span class="group-dot" style="--group-color:${categoryColor(group.color)}"></span><span>${escape(group.label)}</span><small>${nodes.filter(node => node.group === group.id).length}</small></button>`).join('')}
    </div>
    </details>
    <div class="project-directory-host" id="project-directory-host" data-tutorial="project-directory"></div>
    <div class="reading-options" aria-label="显示选项"><button id="toggle-archived" aria-pressed="false">显示已归档</button><label class="mini-check"><input id="detailed-graph" type="checkbox"/>展开全部规则</label></div>
    <div class="sidebar-section entry-heading"><span id="entry-heading">策划条目</span><span id="entry-count"></span></div>
    <div id="node-directory" class="node-directory" aria-label="可选择的策划条目"></div>
    <footer class="sidebar-footer"><span>文档目录</span><span>A BAIGE PROJECT</span></footer>
  </aside>
  <div class="workspace">
    <header class="topbar">
      <div class="workspace-navigation"><button class="icon-button menu-button" id="menu-toggle" aria-label="展开或收起项目目录" aria-expanded="false">${icon('panel-left')}</button><nav class="main-nav" data-tutorial="main-nav" aria-label="查看方式"><button data-view="graph" class="active">${icon('orbit')}知识空间</button><button data-view="document">${icon('file-text')}策划案</button><button data-view="cards">${icon('layout-grid')}卡片库</button><button data-view="creative" data-tutorial="creative-nav">创作模块</button><button data-view="quest" data-tutorial="quest-nav">Quest</button><button data-view="animatic">排演</button></nav><div class="breadcrumb"><span id="breadcrumb-project">${escape(projectSnapshot?.project.name ?? '策问')}</span>${icon('chevron-right')}<strong id="view-title">知识空间</strong></div></div>
      <div class="project-toolbar" aria-label="当前项目操作"><button class="secondary-button" id="new-document" data-tutorial="new-document">${icon('plus')}新建文档</button><button class="secondary-button" id="edit-document" data-tutorial="edit-document">编辑</button><span></span><button class="secondary-button" id="project-statistics" data-tutorial="project-statistics">统计</button><button class="secondary-button" id="project-history" data-tutorial="project-history">版本</button><button class="secondary-button" id="organize-project" data-tutorial="organize-project">整理</button><button class="secondary-button" id="project-inquiry" data-tutorial="project-inquiry">问询</button><button class="secondary-button" id="project-exchange" data-tutorial="project-exchange">交换</button><button class="sample-tag" id="refresh-project" data-tutorial="refresh-project" title="重新扫描外部文档修改">${projectSnapshot?.project.isExample ? '虚构示例 · 刷新文件' : '本地文档 · 刷新文件'}</button></div>
    </header>
    <main class="work-area">
      <section class="graph-view" id="graph-view" aria-label="知识空间">
        <header class="space-toolbar">
          <div class="space-heading"><button class="analysis-back" id="back-to-overview" hidden>${icon('arrow-left')}<span>返回星图总览</span></button><span class="eyebrow" id="space-eyebrow">KNOWLEDGE SPACE</span><h1><span id="space-title">设计星图</span><span id="space-count"></span></h1></div>
          <div class="mode-switch" id="overview-switch" data-tutorial="graph-modes" role="group" aria-label="总览布局">
            <button data-mode="galaxy" aria-pressed="true" class="active">${icon('orbit')}星图总览</button>
            <button data-mode="layers" aria-pressed="false">${icon('layers')}系统分层</button>
            <button data-mode="mindmap" aria-pressed="false">${icon('network')}设计脑图</button>
          </div>
          <div class="layout-direction" id="layout-direction" role="group" aria-label="平面排版方向" hidden><button data-direction="vertical" aria-pressed="true" title="从上到下展开">↓ 竖向</button><button data-direction="horizontal" aria-pressed="false" title="从左向右展开">→ 横向</button></div>
          <span class="analysis-page-note" id="analysis-page-note" hidden>从一个条目，读懂它的直接联系</span>
        </header>
        <div class="space-intro" id="space-intro">在系统之间，发现设计的联系</div>
        <div class="analysis-toolbar" id="analysis-toolbar" hidden><label>分析焦点<select id="analysis-focus" aria-label="选择关系分析焦点"><option value="">请选择条目</option><optgroup label="游戏总纲">${nodes.filter(node=>!node.group).map(node=>`<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>${groups.map(group => `<optgroup label="${escape(group.label)}">${nodes.filter(node => node.group === group.id).map(node => `<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>`).join('')}</select></label><span>建议复核 ≠ 必须修改 · 点击连线查看依据</span></div>
        <div id="graph-canvas" class="graph-canvas" data-tutorial="graph-canvas"></div>
        <div class="graph-empty" id="graph-empty" hidden><strong id="graph-empty-title">没有匹配的条目</strong><p id="graph-empty-description">尝试其他关键词，或清除当前筛选。</p><button class="secondary-button" id="clear-filters">清除筛选</button></div>
        <div class="graph-tools" data-tutorial="graph-tools"><button class="tool-button" id="reset-view" aria-label="返回全图">${icon('focus')}<span>全图</span></button><span class="tool-divider"></span><button class="icon-button" id="zoom-in" aria-label="放大关系图">${icon('plus')}</button><button class="icon-button" id="zoom-out" aria-label="缩小关系图">${icon('minus')}</button><span class="tool-divider"></span><button class="tool-button" id="toggle-labels" aria-pressed="false">标签</button><button class="tool-button" id="toggle-motion" aria-pressed="false" title="暂停关联线上的方向粒子">静止</button></div>
        <div class="space-bottom"><div class="legend">${groups.map(group => `<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('')}</div><span class="gesture" id="gesture">左键平移 · 右键旋转 · 滚轮缩放</span></div>
      </section>
      <section class="reading-view" id="reading-view" hidden aria-label="策划案阅读"></section>
      <section class="cards-view" id="cards-view" hidden aria-label="策划卡片库"></section>
      <section class="creative-view" id="creative-view" hidden aria-label="通用创作工作区"></section><aside class="inspector" id="inspector" aria-label="条目与关系详情"></aside>
    </main>
    <footer class="workspace-footer"><span id="edition-state"><i></i>策问 · ${isWebEdition ? '网页版 · 本机文件' : '本地工作台'}</span><span id="footer-count">${nodes.length} 个条目 · ${edges.length} 条关系</span><span id="project-save-state">${projectSnapshot ? '文档已同步' : '尚未打开项目'}</span></footer>
  </div>
  <div class="announcement" id="announcement" role="status" aria-live="polite"></div>`;

mountDesktopChrome();
await initializeTheme();
setNotebookTexture();
installIconInteractions();

let graph: KnowledgeGraph | undefined;
let creativeWorkspace:CreativeWorkspace|undefined;
let projectDirectory: ProjectDirectory | undefined;
let editingSession:EditingSession|undefined;
let readingReady = false;
let readingTimer: ReturnType<typeof setTimeout> | undefined;
let recentNodes: string[] = [];
const get = (id: string) => document.getElementById(id)!;
if(projectSnapshot)setTutorialProject(projectSnapshot.project.id);
const tutorialManager = new TutorialManager(designformTutorials, message => { const node = document.getElementById('announcement'); if (node) node.textContent = message; });
/** 用户决定目录显隐；分辨率只决定并排还是抽屉，不覆盖已保存选择。 */
let sidebarExpanded = !matchMedia('(max-width:1050px)').matches;
try { const saved = localStorage.getItem('cewen-sidebar-expanded'); if (saved !== null) sidebarExpanded = saved === 'true'; } catch { /* 存储不可用时保留当前会话选择。 */ }
function setSidebarExpanded(expanded: boolean) {
  sidebarExpanded = expanded;
  app.classList.toggle('sidebar-open', expanded);
  app.classList.toggle('sidebar-collapsed', !expanded);
  get('project-sidebar').inert = !expanded;
  get('menu-toggle').setAttribute('aria-expanded', String(expanded));
  get('menu-toggle').setAttribute('aria-controls', 'project-sidebar');
  get('menu-toggle').setAttribute('aria-label', expanded ? '收起项目面板' : '展开项目面板');
  get('menu-toggle').title = `${expanded ? '收起' : '展开'}项目面板 · Ctrl + \\`;
  try { localStorage.setItem('cewen-sidebar-expanded', String(expanded)); } catch { /* 偏好不影响文档保存。 */ }
}
setSidebarExpanded(sidebarExpanded);
const connectionPanel = new ConnectionPanel(get('llm-connection') as HTMLButtonElement, () => projectSnapshot,refreshLive);
/** 目录展开状态按项目保留在本次阅读中，不修改任何策划文档。 */
const directoryExpansion = new Map<string, Set<string>>();

/** 图谱、卡片和目录共用同一搜索条件，避免“切换查看方式后资料消失”的语义差异。 */
function filteredNodes() {
  const query = state.query.trim().toLowerCase();
  const related = new Set([state.selected]);
  const filterRelated = state.directOnly && state.mode !== 'network';
  if (filterRelated && state.selected) edges.forEach(edge => { if (edge.source === state.selected) related.add(edge.target); if (edge.target === state.selected) related.add(edge.source); });
  return nodes.filter(node => (state.includeArchived || node.status !== 'archived') && (!state.scopeIds || state.scopeIds.includes(node.id)) && (!state.group || node.group === state.group || groupAncestors({groups},node.group).some(group=>group.id===state.group)) && (!query || `${node.id} ${node.title} ${node.summary} ${node.content.join(' ')}`.toLowerCase().includes(query)) && (!filterRelated || !state.selected || related.has(node.id)));
}

/** 关系分析始终围绕显式焦点，搜索只筛选候选目录，不悄悄删掉分析依据。 */
function renderAnalysisControls() {
  const analyzing = state.mode === 'network';
  get('overview-switch').hidden = false;
  get('back-to-overview').hidden = !analyzing;
  get('back-to-overview').querySelector('span')!.textContent = `返回${names[analysisOrigin?.mode ?? overviewMode]}`;
  get('analysis-page-note').hidden = !analyzing;
  get('space-eyebrow').hidden = analyzing;
  get('view-title').textContent = state.view === 'graph' ? (analyzing ? '脑图 · 聚焦' : '知识空间') : ({document:'策划案',cards:'卡片库',creative:'创作模块',quest:'Quest / 问策',animatic:'分镜排演'})[state.view as Exclude<View,'graph'>];
  get('analysis-toolbar').hidden = !analyzing;
  (get('analysis-focus') as HTMLSelectElement).value = state.selected ?? '';
  (get('search') as HTMLInputElement).placeholder = analyzing ? '搜索目录，选择分析条目…' : '搜索标题、规则…';
  get('space-title').textContent = analyzing ? '脑图 · 聚焦' : state.mode === 'galaxy' ? '设计星图' : names[state.mode];
  get('layout-direction').hidden = state.mode === 'galaxy';
  document.querySelectorAll<HTMLButtonElement>('[data-direction]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.direction===state.direction)));
  get('toggle-labels').hidden = analyzing;
  get('toggle-motion').hidden = analyzing;
  get('zoom-in').hidden = analyzing;
  get('zoom-out').hidden = analyzing;
  document.querySelectorAll<HTMLElement>('.graph-tools .tool-divider').forEach(divider => { divider.hidden = analyzing; });
  get('reset-view').setAttribute('aria-label', analyzing ? '重置分析布局' : '返回全图');
  get('reset-view').querySelector('span')!.textContent = analyzing ? '重置布局' : '全图';
  get('graph-empty-title').textContent = analyzing ? '选择一个条目，展开它的关系' : nodes.length ? '没有匹配的条目' : '尚无总纲或专项设计';
  get('graph-empty-description').textContent = analyzing ? '可从上方焦点列表或左侧目录开始。' : nodes.length ? '尝试其他关键词，或清除当前筛选。' : '点击「＋ 新建」或右键星空，写下第一份设计。';
  get('clear-filters').textContent = analyzing ? '选择首个条目' : '清除筛选';
}

function renderDirectory() {
  if(projectDirectory){projectDirectory.render();return;}
  const visible = filteredNodes().filter(node => node.kind !== 'system');
  const key = projectSnapshot?.project.id ?? '', expanded = directoryExpansion.get(key) ?? new Set(nodes.filter(node => node.documentType === 'gdd').map(node => node.id));
  directoryExpansion.set(key, expanded);
  const directory = get('node-directory'), scroll = directory.scrollTop;
  const documents = nodes.filter(node => node.kind === 'document' && visible.some(item => item.documentId === node.id)).sort((a,b) => Number(b.documentType === 'gdd') - Number(a.documentType === 'gdd'));
  const nodeButton = (node: KnowledgeNode, rule = false) => `<button data-node="${node.id}" class="directory-node ${rule ? 'directory-rule ' : ''}${state.selected === node.id ? 'selected' : ''}" aria-pressed="${state.selected === node.id}"><span class="kind-marker ${node.kind}"></span><span>${escape(node.title)}</span>${!rule ? `<small>${node.documentType === 'gdd' ? 'GDD' : node.documentType === 'question' ? '问询' : 'DD'}</small>` : ''}</button>`;
  get('entry-count').textContent = String(visible.length);
  directory.innerHTML = documents.length ? documents.map(document => {
    const rules = visible.filter(node => node.kind === 'rule' && node.documentId === document.id);
    const open = expanded.has(document.id) || Boolean(state.query) || rules.some(node => node.id === state.selected);
    return rules.length ? `<details class="document-branch" data-document="${document.id}" ${open ? 'open' : ''}><summary>${nodeButton(document)}<span class="branch-count">${rules.length}</span></summary><div class="directory-rules">${rules.map(node => nodeButton(node,true)).join('')}</div></details>` : nodeButton(document);
  }).join('') : '<p class="quiet empty-directory">没有匹配条目</p>';
  directory.scrollTop = scroll;
  directory.querySelectorAll<HTMLDetailsElement>('details[data-document]').forEach(branch => branch.addEventListener('toggle', () => { if (branch.isConnected) { if (branch.open) expanded.add(branch.dataset.document!); else expanded.delete(branch.dataset.document!); } }));
  get('system-filter-label').textContent = groups.find(group => group.id === state.group)?.label ?? '全部系统';
  document.querySelectorAll<HTMLElement>('[data-group]').forEach(button => button.classList.toggle('active', (button.dataset.group || null) === state.group));
}

/** 详情中的关系同时给出方向、类型与依据；推断关系不会冒充策划中已确认的约束。 */
function renderInspector() {
  const selected = state.selected ? nodeById.get(state.selected) : undefined;
  const edge = state.relationIndex === null ? undefined : edges[state.relationIndex];
  get('inspector').hidden = !selected && !edge && !connectionError && !projectSnapshot?.diagnostics.length;
  app.classList.toggle('inspector-open', !get('inspector').hidden);
  if (edge) {
    const source = nodeById.get(edge.source)!, target = nodeById.get(edge.target)!;
    const semantic = edge.type === 'depends' ? '箭头指向依赖项；修改依赖项时，应回头核对使用它的规则。' : edge.type === 'constrains' ? '箭头从约束规则指向受约束内容；建议复核不代表必须修改。' : edge.type === 'contains' ? '这是内容归属关系，不自动表示改动影响。' : '这是普通关联，存储方向不表示因果或改动传播。';
    get('inspector').innerHTML = `<div class="inspector-heading"><span class="eyebrow">关系依据</span><button class="icon-button" id="close-relation" aria-label="返回条目详情">${icon('x')}</button></div><div class="edge-statement"><span>${escape(source.title)}</span><strong>${edge.type === 'relates' ? '↔' : '↓'} ${types.find(type => type.id === edge.type)!.label}</strong><span>${escape(target.title)}</span></div><div class="evidence-badge">${edge.note.includes('展示推断') ? '展示推断 · 待核对' : '原文依据'}</div><p class="evidence-note">${escape(edge.note)}</p><p class="edge-semantic">${semantic}</p><div class="panel-divider"></div><div class="detail-label">继续分析</div><button class="evidence-node" data-analyze="${source.id}">${escape(source.title)}${icon('arrow-up-right')}</button><button class="evidence-node" data-analyze="${target.id}">${escape(target.title)}${icon('arrow-up-right')}</button><div class="source-block"><span>两端资料</span><p>${escape(sourceName(source.source))}</p><p>${escape(sourceName(target.source))}</p></div>`;
    if(!projectSnapshot?.historical){const button=document.createElement('button');button.className='secondary-button';button.dataset.graphCommand='edge';button.textContent=edge.origin?.kind==='markdown'?'修改正文引用':'编辑这条关系';get('inspector').append(button);const review=document.createElement('button');review.className='secondary-button';review.textContent='让 LLM 检查这条关系';review.onclick=()=>void openCollaboration('review',projectSnapshot,[source.documentId,target.documentId].filter(Boolean),{extra:`请检查「${source.title}」与「${target.title}」的关系。当前类型：${types.find(t=>t.id===edge.type)?.label}。来源：${edge.origin?.kind??'文档'}。依据：${edge.note}。区分正文提及、主要分类和真正的设计依赖，不按位置或同名词猜测关系。`,fixed:true});get('inspector').append(review);}
    refreshIcons();
    return;
  }
  if (!selected) {
    get('inspector').innerHTML = `<div class="inspector-heading"><span class="eyebrow">项目概览</span>${icon('orbit')}</div><h2>${escape(projectSnapshot?.project.name ?? '从你的第一份策划开始')}</h2><p class="overview-description">${escape(projectSnapshot?.project.description || '新建文档、写下规则，逐步连接你的游戏设计。')}</p><div class="overview-stats"><div><b>${nodes.length}</b><span>策划条目</span></div><div><b>${edges.length}</b><span>知识关联</span></div></div><div class="panel-divider"></div><div class="detail-label">从一个系统开始</div><div class="overview-groups">${groups.map(group => { const node = nodes.find(item => item.group === group.id && item.kind === 'system')!; return `<button data-node="${node.id}"><span class="group-dot" style="--group-color:${categoryColor(group.color)}"></span>${escape(group.label)}${icon('arrow-up-right')}</button>`; }).join('')}</div><div class="reading-note">${projectSnapshot?.project.isExample ? '这是完全虚构的基础示例，可自由修改。' : '正文来自项目 Markdown，可用普通编辑器直接读写。'}<br>点击星点或目录条目，查看正文与关联。</div>${projectSnapshot?.diagnostics.length ? `<div class="project-warning">${projectSnapshot.diagnostics.map(issue => escape(`${issue.path}：${issue.message}`)).join('<br>')}</div>` : ''}${connectionError ? `<div class="project-warning">${escape(connectionError)}</div>` : ''}`;
  } else {
    const group = groupOf(selected);
    const relations = edges.filter(edge => edge.source === selected.id || edge.target === selected.id);
    get('inspector').innerHTML = `<div class="inspector-heading"><span class="eyebrow">${kindNames[selected.kind]}</span><button class="icon-button" id="clear-selection" aria-label="关闭条目详情">${icon('x')}</button></div><div class="detail-group" style="--group-color:${categoryColor(group.color)}"><i></i>${escape(group.label)}</div><h2>${escape(selected.title)}</h2><div class="detail-meta">${status(selected)}<span>${relations.length} 条关联</span></div><p class="detail-summary">${escape(selected.summary)}</p><button class="read-button" id="read-selected">${icon('file-text')}阅读全文${icon('arrow-up-right')}</button><div class="record-actions"><button id="item-history">条目历史</button><button id="document-history">文档历史</button><button id="copy-node-link">复制条目链接</button></div><div class="panel-divider"></div><div class="related-heading"><span>直接关联</span><label class="mini-check"><input type="checkbox" id="direct-only" ${state.directOnly ? 'checked' : ''}/>只看相关</label></div><div class="relation-list">${relations.map(edge => { const outward = edge.source === selected.id; const other = nodeById.get(outward ? edge.target : edge.source)!; const type = types.find(type => type.id === edge.type)!.label; const label = edge.type === 'relates' ? '关联' : `${outward ? '→' : '←'} ${type}`; return `<div class="relation-item"><button data-node="${other.id}"><span class="relation-type">${label}</span><span>${escape(other.title)}</span>${icon('chevron-right')}</button><p>${escape(edge.note)}</p></div>`; }).join('')}</div><div class="source-block"><span>资料来源</span><p>${escape(sourceName(selected.source))}</p><small>“已有依据”指设计有据，不代表已实现。</small></div>`;
  }
  if (selected) {
    // 总览先选中条目，再通过明确入口深入分析，单击星点仍可快速浏览摘要。
    if (state.mode !== 'network') {
      const entry = document.createElement('button');
      entry.id = 'analyze-selected';
      entry.className = 'analyze-button';
      entry.setAttribute('aria-label', '分析关系');
      entry.innerHTML = `${icon('network')}<span>分析关系<small>查看前提、约束与相关问题</small></span>${icon('arrow-up-right')}`;
      get('read-selected').before(entry);
    }
    const relatedEdges = edges.filter(edge => edge.source === selected.id || edge.target === selected.id);
    get('inspector').querySelectorAll('.relation-item').forEach((item, index) => {
      const button = document.createElement('button');
      button.className = 'relation-evidence-button';
      button.dataset.edge = String(edges.indexOf(relatedEdges[index]));
      button.textContent = '查看关系依据';
      item.append(button);
    });
    if (state.mode === 'network') {
      get('clear-selection').setAttribute('aria-label', '关闭分析并返回总览');
      const depth = document.createElement('span');
      depth.className = 'analysis-depth';
      depth.textContent = '一层直接关系';
      get('inspector').querySelector('.mini-check')?.replaceWith(depth);
    }
  }
  if(selected&&selected.kind!=='system'&&!projectSnapshot?.historical){
    const actions=document.createElement('div');actions.className='graph-selected-actions';
    actions.innerHTML='<button data-graph-command="connect">添加手工关联</button><button data-graph-command="classify">修改分类</button>';
    get('inspector').append(actions);
  }
  refreshIcons();
}

let readingDisposers:(()=>void)[]=[];
function renderReading() {
  readingDisposers.forEach(dispose=>dispose());readingDisposers=[];
  closeReadingPreview();
  const visible = filteredNodes();
  const selected = state.selected ? nodeById.get(state.selected) : undefined;
  const ids = new Set((selected ? [selected] : visible).map(node => node.documentId));
  const documents = projectSnapshot?.documents.filter(document => ids.has(document.id)).sort((a, b) => Number(b.type === 'gdd') - Number(a.type === 'gdd')) ?? [];
  get('reading-view').innerHTML = `<header class="reading-header"><span class="eyebrow">DESIGN DOCUMENTS</span><h1>${selected ? escape(selected.title) : escape(projectSnapshot?.project.name ?? '未命名项目') + ' · 策划案'}</h1><p>${projectSnapshot?.historical ? `${projectSnapshot.revisionLabel} · 历史策划` : '从设计正文开始阅读，悬停带下划线的词语可预览相关设计。'}</p><div class="reading-navigation">${readingTrail.length ? `<button class="text-button" id="reading-back">${icon('arrow-left')}返回上一处</button>` : ''}${selected ? `<button class="text-button" id="read-all">返回策划案总览</button>` : ''}</div></header><div class="document-content">${documents.map(document => `<article class="document-section" id="doc-${document.id}"><div class="document-presentation-host"></div><footer class="document-reading-footer"><div class="document-source">${escape(document.path)}</div><button class="text-button" data-locate="${document.id}">${icon('network')}在关系网中定位${icon('arrow-up-right')}</button></footer></article>`).join('') || '<div class="reading-empty">没有找到匹配文档。可以新建一份 GDD 或 DD。</div>'}</div>`;
  // 正文编辑入口统一进入策划案，沿用文档身份对应的锁定状态与同一份草稿。
  for(const doc of documents){const host=get('reading-view').querySelector<HTMLElement>(`#doc-${CSS.escape(doc.id)} .document-presentation-host`)!;readingDisposers.push(mountDocumentPresentation(host,doc,projectSnapshot!,{onEdit:()=>{documentDesktop?.openDocument(doc.id,true);}}));}
  refreshIcons();
}

/** 页容量由当前可用面积决定，窗口变化后保持所在卡片附近而不启用纵向滚动。 */
const cardPaging = { page: 0, capacity: 1, columns: 1, rows: 1, key: '' };
let cardInspectTimer: ReturnType<typeof setTimeout> | undefined;
function cardPageLayout() {
  const host = get('cards-view'), style = getComputedStyle(host);
  const width = Math.max(180, (host.clientWidth || 900) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const height = Math.max(190, (host.clientHeight || innerHeight - 150) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 102);
  const gap = innerWidth <= 700 ? 10 : 14;
  const columns = Math.max(1, Math.floor((width + gap) / (230 + gap))), rows = Math.max(1, Math.floor((height + gap) / (240 + gap)));
  return { columns, rows, capacity: columns * rows };
}
const cardDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function cardTime(value?: string) { return value && Number.isFinite(Date.parse(value)) ? cardDate.format(new Date(value)) : '暂无记录'; }
function renderCards() {
  // 搜索可以命中正文规则，但卡片身份始终是所属文档，分类节点不生成卡片。
  const matchedDocuments = new Set(filteredNodes().filter(node => node.kind !== 'system').map(node => node.documentId));
  const visible = nodes.filter(node => node.kind === 'document' && (state.includeArchived || node.status!=='archived') && matchedDocuments.has(node.documentId));
  const preferences=projectSnapshot?readDocumentListState(projectSnapshot):undefined;
  const listSnapshot=projectSnapshot&&!projectSnapshot.historical?documentDesktop?.documentListSnapshot(projectSnapshot.project.id)??projectSnapshot:projectSnapshot;
  if(listSnapshot&&preferences){
    const docs=sortDocuments(listSnapshot,listSnapshot.documents,preferences.sort,preferences.categoryPins[documentPinScope('documents',state.group??'')]??[]);
    const rank=new Map(docs.map((doc,index)=>[doc.id,index]));
    // 卡片与文档目录共用排序和当前分类图钉，搜索命中不改变原来的排序偏好。
    visible.sort((a,b)=>(rank.get(a.documentId)??docs.length)-(rank.get(b.documentId)??docs.length)||documentNameOrder.compare(a.title,b.title));
  }
  const key = JSON.stringify([projectSnapshot?.project.id, state.group, state.query, state.scopeIds, state.includeArchived, state.directOnly, preferences?.sort]);
  const layout = cardPageLayout(), start = cardPaging.page * cardPaging.capacity;
  if (key !== cardPaging.key) cardPaging.page = 0;
  else if (layout.capacity !== cardPaging.capacity) cardPaging.page = Math.floor(start / layout.capacity);
  Object.assign(cardPaging, layout, { key });
  const pages = Math.max(1, Math.ceil(visible.length / cardPaging.capacity)); cardPaging.page = Math.min(cardPaging.page, pages - 1);
  const current = visible.slice(cardPaging.page * cardPaging.capacity, (cardPaging.page + 1) * cardPaging.capacity);
  const metadata = (node: KnowledgeNode) => {
    // 创建时间、编辑时间和版本只取这份文档，不再汇总分类或章节。
    const docs = listSnapshot?.documents.filter(doc => doc.id === node.documentId) ?? [];
    const newest = [...docs].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))[0];
    const created = docs.map(doc => doc.createdAt).filter((time): time is string => !!time).sort()[0];
    const draft = docs.some(doc => projectSnapshot?.documents.find(original => original.id === doc.id)?.text !== doc.text);
    return `<span class="card-metadata"><span>创建<time datetime="${escape(created ?? '')}">${escape(cardTime(created))}</time></span><span>最后编辑<time datetime="${escape(newest?.updatedAt ?? '')}">${escape(cardTime(newest?.updatedAt))}</time></span><span>版本<b>${escape(newest?.revisionLabel ?? '未入版本')}${draft ? ' · 草稿' : ''}</b></span></span>`;
  };
  get('cards-view').innerHTML = `<header class="card-library-header"><h1>策划卡片<span class="title-count">${visible.length}</span></h1></header><div class="card-grid" style="--card-columns:${layout.columns};--card-rows:${layout.rows}">${current.map(node => `<button class="design-card ${node.id === state.selected ? 'selected' : ''}" data-node="${node.id}" title="${escape(node.title)}" aria-label="${escape(node.title)}，双击打开文档" style="--group-color:${categoryColor(node.color??groupOf(node).color)}"><span class="card-top"><i class="card-color" aria-hidden="true"></i>${icon('file-text')}</span><h2>${escape(node.title)}</h2><p>${escape(node.summary)}</p><span class="card-bottom">${status(node)}<span>文档</span></span>${metadata(node)}</button>`).join('') || '<div class="reading-empty">没有匹配的文档，可调整搜索或分类。</div>'}</div><footer class="card-library-pagination" aria-label="卡片分页"><button data-card-page="-1" aria-label="上一页卡片" ${cardPaging.page === 0 ? 'disabled' : ''}>${icon('chevron-left')}上一页</button><span aria-live="polite">${cardPaging.page + 1} / ${pages} 页 · 共 ${visible.length} 张</span><button data-card-page="1" aria-label="下一页卡片" ${cardPaging.page === pages - 1 ? 'disabled' : ''}>下一页${icon('chevron-right')}</button></footer>`;
  if(projectSnapshot&&preferences){
    const snapshot=projectSnapshot,sort=document.createElement('button');sort.className='card-library-sort';sort.innerHTML=`${icon('arrow-up-down')}<span>${documentSortLabels[preferences.sort]}</span>`;sort.setAttribute('aria-label','卡片库排序');sort.setAttribute('aria-haspopup','menu');
    sort.onclick=()=>showAppMenu((Object.entries(documentSortLabels) as [DocumentSort,string][]).map(([value,label])=>({label:`${preferences.sort===value?'✓ ':''}${label}`,run:()=>{preferences.sort=value;saveDocumentListState(snapshot,preferences);}})),sort);
    get('cards-view').querySelector('header')!.append(sort);
  }
  refreshIcons();
}
let cardResizeFrame = 0;
const cardResize = new ResizeObserver(() => {
  if (state.view !== 'cards' || cardResizeFrame) return;
  cardResizeFrame = requestAnimationFrame(() => { cardResizeFrame = 0; const next = cardPageLayout(); if (next.capacity !== cardPaging.capacity || next.columns !== cardPaging.columns) renderCards(); });
});
cardResize.observe(get('cards-view'));
/** 触控板一段连续滑动只翻一页；边界也消化滚轮，避免滚动穿透到外层。 */
let cardWheelAmount = 0, cardWheelDirection = 0, cardWheelLatched = false;
let cardWheelReset: ReturnType<typeof setTimeout> | undefined;
get('cards-view').addEventListener('wheel', event => {
  if (state.view !== 'cards' || event.ctrlKey) return;
  event.preventDefault(); event.stopPropagation();
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  const direction = Math.sign(delta); if (!direction) return;
  clearTimeout(cardWheelReset);
  cardWheelReset = setTimeout(() => { cardWheelAmount = 0; cardWheelDirection = 0; cardWheelLatched = false; }, 170);
  if (cardWheelLatched) return;
  if (direction !== cardWheelDirection) cardWheelAmount = 0;
  cardWheelDirection = direction;
  cardWheelAmount += Math.abs(delta) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? get('cards-view').clientHeight : 1);
  if (cardWheelAmount < 36) return;
  cardWheelLatched = true;
  const pageButton = get('cards-view').querySelector<HTMLButtonElement>(`[data-card-page="${direction}"]`);
  if (!pageButton || pageButton.disabled) return;
  clearTimeout(cardInspectTimer); cardPaging.page += direction; renderCards();
}, { passive: false });
get('cards-view').addEventListener('dblclick', event => {
  const id = (event.target as HTMLElement).closest<HTMLElement>('.design-card[data-node]')?.dataset.node;
  const node = id ? nodeById.get(id) : undefined; if (!node) return;
  clearTimeout(cardInspectTimer); event.preventDefault(); window.dispatchEvent(new CustomEvent('cewen:read-document', { detail: node.documentId }));
});
/** 文档页修改排序或图钉后，已打开的卡片库同步采用相同偏好。 */
window.addEventListener('cewen:document-list-change',event=>{
  if((event as CustomEvent<{projectId:string}>).detail.projectId===projectSnapshot?.project.id&&state.view==='cards')renderCards();
});

/** 更新阅读内容而不重建场景；这个边界也是未来接入模型操作接口的位置。 */
function sync(updateGraph = true, updateCards = true, updateInspector = true) {
  if (readingReady && projectSnapshot && !projectSnapshot.historical) { clearTimeout(readingTimer); const id = projectSnapshot.project.id; readingTimer = setTimeout(() => { void projectAction(id, 'reading-view', { state: { ...state }, layout: graph?.exportLayout(), recent: recentNodes }).catch(reportProjectError); }, 900); }
  get('toggle-archived').textContent=state.includeArchived?'隐藏已归档':'显示已归档';get('toggle-archived').setAttribute('aria-pressed',String(state.includeArchived));
  renderAnalysisControls();
  renderEditingState();
  renderDirectory();
  if (updateInspector) renderInspector();
  if (updateGraph) graph?.setState(state);
  if (state.view === 'document') renderReading();
  if (state.view === 'cards' && updateCards) renderCards();
}

function selectNode(id: string, preserveCardGrid = false) {
  historyPanel.stop();
  if (!nodeById.has(id)) return;
  const refocusing = state.mode === 'network' && state.selected !== id;
  // 先保存真实画面，再调整滚动与布局；避免过渡启动后滚动让卡片起点跳走。
  if (refocusing) graph?.captureNavigationFrame();
  state.selected = id;
  recentNodes = [id, ...recentNodes.filter(nodeId => nodeId !== id)].slice(0,20);
  state.relationIndex = null;
  // 从详情跳到跨系统条目时解除原系统过滤，确保选中对象实际可见。
  if (state.group && nodeById.get(id)!.group !== state.group && !groupAncestors({groups},nodeById.get(id)!.group).some(group=>group.id===state.group)) state.group = null;
  state.query = '';
  (get('search') as HTMLInputElement).value = '';
  // 卡片单击不能替换点击中的 DOM，否则紧接的双击会丢失落点。
  sync(!refocusing, !preserveCardGrid, !preserveCardGrid);
  if (preserveCardGrid) {
    get('cards-view').querySelectorAll<HTMLElement>('.design-card').forEach(card => card.classList.toggle('selected', card.dataset.node === id));
    // 给双击保留稳定命中区域，双击时间窗结束后才展开可能挤压卡片的详情面板。
    clearTimeout(cardInspectTimer); cardInspectTimer = setTimeout(() => { if (state.view === 'cards' && state.selected === id) renderInspector(); }, 650);
  }
  if (refocusing) {
    get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
    if (state.view === 'graph') revealGraphOnMobile();
    graph?.setState(state, { deferLayout: true });
    graph?.setMode('network');
  }
  get('announcement').textContent = `已选择${nodeById.get(id)!.title}`;rememberWorkspaceVisit();
}

/** 空白点击只解除焦点，不重置用户旋转后的星图镜头或当前系统筛选。 */
function clearOverviewSelection() {
  if (state.mode === 'network' || (!state.selected && state.relationIndex === null)) return;
  state.selected = null; state.relationIndex = null; state.directOnly = false;
  sync(false); graph?.setState(state, { preserveCamera: true });
  get('announcement').textContent = '已取消选择。';
}

/** 导航批量更新时先恢复页面尺寸，延后场景同步，由后续 setMode 一次完成过渡。 */
function setView(view: View, deferGraph = false) {
  clearTimeout(cardInspectTimer);
  if(view==='document'&&documentDesktop&&!projectSnapshot?.historical){documentDesktop.show();const id=state.selected?nodeById.get(state.selected)?.documentId:projectSnapshot?.documents[0]?.id;if(id)documentDesktop.openDocument(id,true);return;}
  documentDesktop?.leaveQuestionMode();
  if(documentDesktop)documentDesktop.root.hidden=true;app.classList.remove('document-canvas-open');get('inspector').hidden=false;
  state.view = view;
  get('graph-view').hidden = view !== 'graph';
  get('reading-view').hidden = view !== 'document';
  get('cards-view').hidden = view !== 'cards';
  const creative=['creative','quest','animatic'].includes(view);get('creative-view').hidden=!creative;
  if(creative)creativeWorkspace?.activate(view==='quest'?'quests':view==='animatic'?'sequences':'objects');else creativeWorkspace?.deactivate();
  get('view-title').textContent = { graph: '知识空间', document: '策划案', cards: '卡片库',creative:'创作模块',quest:'Quest / 问策',animatic:'分镜排演' }[view];
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if(view==='graph'&&!graph)graph=mountGraph();
  graph?.setActive(view === 'graph', { deferLayout: deferGraph });
  sync(!deferGraph);rememberWorkspaceVisit();
}

/** 记录不同页面与图谱模式；切换只恢复阅读状态，不提交版本或替换文档草稿。 */
function rememberWorkspaceVisit(){
  if(!projectSnapshot||documentDesktop?.visible)return;const project=projectSnapshot.project.id;historyScope(project);const saved={view:state.view,mode:state.mode,selected:state.selected,group:state.group,query:state.query,scopeIds:state.scopeIds?[...state.scopeIds]:null};
  let scroll=get(saved.view==='cards'?'cards-view':saved.view==='document'?'reading-view':saved.view==='graph'?'graph-view':'creative-view').scrollTop;
  recordVisit('workspace:'+JSON.stringify(saved),()=>{if(projectSnapshot?.project.id!==project)throw new Error('浏览历史属于其他项目。');Object.assign(state,saved);setView(saved.view);if(saved.view==='graph'){graph?.setState(state,{deferLayout:true});graph?.setMode(saved.mode);}requestAnimationFrame(()=>get(saved.view==='cards'?'cards-view':saved.view==='document'?'reading-view':saved.view==='graph'?'graph-view':'creative-view').scrollTop=scroll);},()=>{scroll=get(saved.view==='cards'?'cards-view':saved.view==='document'?'reading-view':saved.view==='graph'?'graph-view':'creative-view').scrollTop;});
}

/** 三种总览共享场景；脑图的聚焦模式复用原有关系分析动画。 */
function setGraphMode(mode: OverviewMode) {
  if (state.mode === 'network') graph?.captureNavigationFrame();
  analysisOrigin = null;
  overviewMode = mode;
  state.mode = mode;
  if (mode === 'mindmap') state.selected = null;
  state.relationIndex = null;
  updateSpaceNavigation();
  sync(false);
  graph?.setState(state, { deferLayout: true });
  graph?.setMode(mode);
  get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
  get('announcement').textContent = `已切换到${names[mode]}`;rememberWorkspaceVisit();
}

/** 脑图聚焦仍保留三种布局入口，并用返回按钮恢复进入前的总览。 */
function updateSpaceNavigation() {
  const mode = state.mode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(item => { const active=item.dataset.mode===(mode==='network'?'mindmap':mode);item.classList.toggle('active',active); item.setAttribute('aria-pressed',String(active)); });
  get('gesture').textContent = mode === 'galaxy' ? '左键平移 · 右键旋转 · 滚轮缩放' : mode === 'network' ? '滚动阅读 · 点击卡片更换焦点 · 点击连线看依据' : '左键平移 · 右键框选 · 滚轮缩放';
  get('space-intro').textContent = { galaxy: '在系统之间，发现设计的联系', network: '当前节点的直接联系 · 点击相邻卡片继续追踪', layers: '按系统归位，从总纲逐层阅读到规则', mindmap:'从总纲展开设计脉络 · 点击卡片聚焦关系' }[mode];
}

/** 进入分析前保存总览上下文；在分析中继续追踪邻居不会覆盖原来的返回位置。 */
function enterAnalysis(id: string) {
  if (!nodeById.has(id)) return;
  if (state.mode === 'network') { selectNode(id); if (state.view !== 'graph') setView('graph'); return; }
  if (state.view === 'graph') revealGraphOnMobile();
  graph?.captureNavigationFrame();
  analysisOrigin = { mode: state.mode, selected: state.selected, group: state.group, query: state.query, directOnly: state.directOnly };
  graph?.rememberOverview();
  state.selected = id;
  state.relationIndex = null;
  // 先让隐藏的图谱恢复有效尺寸，再从原来的星图或分层位置展开。
  if (state.view !== 'graph') setView('graph', true);
  state.mode = 'network';
  updateSpaceNavigation();
  sync(false);
  graph?.setState(state, { deferLayout: true });
  get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
  revealGraphOnMobile();
  graph?.setMode('network');
  get('back-to-overview').focus({ preventScroll: true });
  get('announcement').textContent = `正在分析${nodeById.get(id)!.title}，可返回${names[analysisOrigin.mode]}`;
}

/** 从分析页返回原总览；分析期间的换焦点与目录筛选不覆盖原来的浏览位置。 */
function leaveAnalysis() {
  if (state.mode !== 'network') return;
  if (state.view !== 'graph') setView('graph', true);
  revealGraphOnMobile();
  graph?.captureNavigationFrame();
  const origin = analysisOrigin ?? { mode: overviewMode, selected: state.selected, group: null, query: '', directOnly: false };
  Object.assign(state, origin, { relationIndex: null });
  overviewMode = origin.mode;
  (get('search') as HTMLInputElement).value = state.query;
  updateSpaceNavigation();
  sync(false);
  graph?.setState(state, { deferLayout: true });
  get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
  revealGraphOnMobile();
  graph?.setMode(origin.mode, { restoreOverview: true });
  analysisOrigin = null;
  (document.getElementById('analyze-selected') ?? document.querySelector<HTMLButtonElement>(`[data-mode="${origin.mode}"]`))?.focus({ preventScroll: true });
  get('announcement').textContent = `已返回${names[origin.mode]}，恢复原来的选择与视角`;
}

/** 手机详情位于图谱下方，进入次级页时把阅读起点带回图谱标题。 */
function revealGraphOnMobile() {
  if (matchMedia('(max-width: 700px)').matches) get('graph-view').scrollIntoView({ behavior: 'instant', block: 'start' });
}

/** 选中关系只展开说明，不更换当前分析焦点，也不修改任何策划关系。 */
function selectRelation(index: number) {
  if (!edges[index]) return;
  state.relationIndex = index;
  sync();
  get('announcement').textContent = edgeSentence(index);
  if (matchMedia('(max-width: 700px)').matches) get('inspector').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

/** 一处事件分发处理动态生成的目录、关系和卡片，避免每次渲染遗留重复监听器。 */
app.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#cewen-doc="]');
  if (link) {
    event.preventDefault(); const id = decodeURIComponent(link.hash.slice('#cewen-doc='.length)); if (!nodeById.has(id)) return;
    readingTrail.push({ selected: state.selected, scroll: get('reading-view').scrollTop, group: state.group, scopeIds: state.scopeIds, query: state.query });
    state.scopeIds = null; selectNode(id); setView('document');
    const node = nodeById.get(id)!;
    const target = node.anchor ? get('reading-view').querySelector(`#doc-${CSS.escape(node.documentId)} [id="${CSS.escape(node.anchor)}"]`) : get('reading-view').querySelector('article');
    if (node.anchor && target) target.scrollIntoView({ block: 'start', behavior: 'instant' }); else get('reading-view').scrollTop = 0;
    const heading = target?.nextElementSibling ?? target?.parentElement?.nextElementSibling; if (node.anchor && heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.dataset.cardPage) { cardPaging.page += Number(button.dataset.cardPage); renderCards(); return; }
  if (button.dataset.direction) { state.direction=button.dataset.direction as GraphDirection;graph?.setDirection(state.direction);sync(false);return; }
  if (button.dataset.edge !== undefined) { selectRelation(Number(button.dataset.edge)); return; }
  if (button.dataset.analyze) { enterAnalysis(button.dataset.analyze); return; }
  if (button.dataset.node) { selectNode(button.dataset.node, button.classList.contains('design-card')); return; }
  if (button.dataset.locate) { selectNode(button.dataset.locate); setView('graph'); graph?.reset(); return; }
  if (button.dataset.view) { setView(button.dataset.view as View); return; }
  if (button.dataset.mode) {
    setGraphMode(button.dataset.mode as OverviewMode);
    return;
  }
  if ('group' in button.dataset) { state.group = button.dataset.group || null; state.directOnly = false; if (state.mode !== 'network') { state.selected = null; state.relationIndex = null; } (document.querySelector('.system-filter') as HTMLDetailsElement).open = false; sync(); return; }
  switch (button.id) {
    case 'tutorial-help': void documentDesktop?.examples().catch(reportProjectError); break;
    case 'project-center': void documentDesktop?.showLibrary().catch(reportProjectError); break;
    case 'project-switch': if(projectSnapshot)openProjectDetails(projectSnapshot,applyProject);else void documentDesktop?.showLibrary().catch(reportProjectError);break;
    case 'project-statistics': if(projectSnapshot)openContentOverview(projectSnapshot);break;
    case 'new-document': documentDesktop?.show();void documentDesktop?.newDocument(state.group??'').catch(reportProjectError); break;
    case 'edit-document': if(state.selected)documentDesktop?.openDocument(nodeById.get(state.selected)?.documentId??state.selected,true); break;
    case 'item-history': if (state.selected) void historyPanel.itemHistory(state.selected, false).catch(reportProjectError); break;
    case 'document-history': if (state.selected) void historyPanel.itemHistory(nodeById.get(state.selected)!.documentId, true).catch(reportProjectError); break;
    case 'copy-node-link': if (state.selected && projectSnapshot) { const url = new URL(location.href); url.searchParams.set('project', projectSnapshot.project.id); url.hash = `cewen-doc=${encodeURIComponent(state.selected)}`; void navigator.clipboard.writeText(url.href).then(() => { get('announcement').textContent = '条目链接已复制。'; }).catch(reportProjectError); } break;
    case 'recent-reading': if (recentNodes.length) { state.scopeIds = recentNodes.filter(id => nodeById.has(id)); state.selected = null; sync(); } break;
    case 'project-history': void historyPanel.open().catch(reportProjectError); break;
    case 'organize-project': void workspacePanel.open(state.selected ?? '').catch(reportProjectError); break;
    case 'project-inquiry': void collaborationPanel.open('inquiry').catch(reportProjectError); break;
    case 'project-exchange': void collaborationPanel.open('exchange').catch(reportProjectError); break;
    case 'toggle-archived': state.includeArchived = !state.includeArchived; window.dispatchEvent(new CustomEvent('cewen:archive-filter',{detail:state.includeArchived})); projectDirectory?.render(); button.textContent = state.includeArchived ? '隐藏已归档' : '显示已归档'; button.setAttribute('aria-pressed', String(state.includeArchived)); sync(); break;
    case 'save-reading-view': void workspacePanel.saveCurrentView().catch(reportProjectError); break;
    case 'reset-reading-filters': state.scopeIds = null; state.group = null; state.query = ''; state.directOnly = false; (get('search') as HTMLInputElement).value = ''; sync(); break;
    case 'refresh-project': void refreshProject(true).catch(reportProjectError); break;
    case 'analyze-selected': if (state.selected) enterAnalysis(state.selected); break;
    case 'back-to-overview': leaveAnalysis(); break;
    case 'clear-selection':
      if (state.mode === 'network') leaveAnalysis();
      else clearOverviewSelection();
      break;
    case 'close-relation': state.relationIndex = null; sync(); break;
    case 'reading-back': { const previous = readingTrail.pop(); if (previous) { const { scroll, ...reading } = previous; Object.assign(state, reading); sync(); get('reading-view').scrollTop = scroll; } break; }
    case 'read-all': readingTrail.length = 0; state.selected = null; state.relationIndex = null; state.directOnly = false; sync(); get('reading-view').scrollTop = 0; break;
    case 'read-selected': setView('document'); break;
    case 'reset-view': graph?.reset(); break;
    case 'zoom-in': graph?.zoom(.82); break;
    case 'zoom-out': graph?.zoom(1.22); break;
    case 'toggle-labels': state.labelsAll = !state.labelsAll; button.setAttribute('aria-pressed', String(state.labelsAll)); sync(); break;
    case 'toggle-motion': state.paused = !state.paused; button.setAttribute('aria-pressed', String(state.paused)); sync(); break;
    case 'menu-toggle': setSidebarExpanded(!sidebarExpanded); break;
    case 'sidebar-close': case 'sidebar-scrim': setSidebarExpanded(false); get('menu-toggle').focus(); break;
    case 'clear-filters': state.scopeIds = null; state.group = null; state.query = ''; state.directOnly = false; if (state.mode === 'network') state.selected = nodes[0]?.id ?? null; (get('search') as HTMLInputElement).value = ''; sync(); break;
  }
});

app.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'direct-only') { state.directOnly = input.checked; sync(); }
  if (input.id === 'detailed-graph') { state.detailedGraph = (input as unknown as HTMLInputElement).checked; sync(); }
  if (input.id === 'analysis-focus') { if (input.value) selectNode(input.value); }
});
get('search').addEventListener('input', event => { state.query = (event.target as HTMLInputElement).value; sync(); });
document.addEventListener('keydown', event => {
  if(documentDesktop?.visible)return;
  if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;
  const typing = !!(event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]');
  if ((event.ctrlKey || event.metaKey) && event.key === '\\') { event.preventDefault(); setSidebarExpanded(!sidebarExpanded); return; }
  const action=shortcutAction(event);if(!typing&&action&&['save','saveAll','undo','redo','copy','cut','paste','selectAll','find'].includes(action)&&!(action==='copy'&&window.getSelection()?.toString())){event.preventDefault();void graphCommand(action==='find'?'search':action==='saveAll'?'save':action).catch(reportProjectError);return;}
  if(!typing&&action==='delete'&&state.view==='graph'){event.preventDefault();if(state.relationIndex!==null)void graphCommand('edge').catch(reportProjectError);else void documentDesktop?.deleteFromGraph(graph?.selectedIds()??(state.selected?[state.selected]:[])).catch(reportProjectError);}
  if (event.key === '/' && !typing) { event.preventDefault(); setSidebarExpanded(true); document.querySelector<HTMLInputElement>('.project-directory-top input')?.focus(); }
  if (event.key === 'Escape') {
    const menuOpen = sidebarExpanded && matchMedia('(max-width:1050px)').matches;
    if (menuOpen) { setSidebarExpanded(false); get('menu-toggle').focus(); }
    if (!menuOpen && !typing && state.view === 'graph' && state.mode === 'network') leaveAnalysis();
  }
});

/** 显卡不可用时仍保留可阅读的策划和卡片，明确提示而不是留下一块空白。 */
function mountGraph(): KnowledgeGraph | undefined {
  // 文档工作台隐藏旧画布时延迟初始化，避免零尺寸标签和后台渲染。
  if (!get('graph-canvas').clientWidth || !get('graph-canvas').clientHeight) return undefined;
try {
  graph = new KnowledgeGraph(get('graph-canvas'), id=>{if(state.mode==='mindmap')enterAnalysis(id);else selectNode(id);}, count => {
    get('space-count').textContent = `${count} 个条目`;
    get('graph-empty').hidden = count > 0;
    get('footer-count').textContent = `${count} / ${nodes.length} 个条目 · ${edges.length} 条关系`;
  }, selectRelation, { nodes, edges, groups,rootDocumentId:projectSnapshot?.rootDocumentId }, clearOverviewSelection);
  graph.setDirection(state.direction);
  graph.configureEditing((edit,before,after)=>{void finishGraphGesture(edit,before,after).catch(reportProjectError);},!projectSnapshot?.historical);
  return graph;
} catch (error) {
  get('graph-canvas').innerHTML = `<div class="webgl-error"><h2>当前浏览器未能启动三维画面</h2><p>可先在策划案或卡片库阅读，也可在支持 WebGL 的浏览器重试。</p><button class="secondary-button" data-view="document">打开策划案</button></div>`;
  console.error('知识空间渲染初始化失败：', error);
  return undefined;
}
}

/** 项目变化只更新读取模型；同拓扑正文编辑不重建画布或清空分析卡片。 */
function applyProject(snapshot: ProjectSnapshot, projected=false) {
  if(!projected&&editingSession)snapshot=editingSession.receive(snapshot);
  const sameProject = projectSnapshot?.project.id === snapshot.project.id;
  if (!sameProject || projectSnapshot?.revision !== snapshot.revision) readingTrail.length = 0;
  const relationId = state.relationIndex === null ? null : edges[state.relationIndex]?.id;
  projectSnapshot = snapshot;
  // 环境部署异步进行，下载或配对失败不阻断项目阅读与人工编辑。
  if(!projected)void Promise.resolve().then(()=>onConnectorProject(snapshot)).catch(reportProjectError);
  syncLive(snapshot);setTutorialProject(snapshot.project.id);
  window.dispatchEvent(new CustomEvent('cewen:collaboration-change'));
  const workView=projectWorkView(snapshot);
  // 图谱正文从工作投影重新解析，正式快照与人工保存基准始终独立。
  const readingSnapshot=workView===snapshot?snapshot:{...workView,...parseKnowledge([{path:'PROJECT.md',text:snapshot.projectEntry?.text??'',hash:snapshot.projectEntry?.hash??''},...workView.documents])};
  creativeWorkspace?.receive(snapshot);
  setKnowledgeData(readingSnapshot);
  get('footer-count').textContent=nodes.length+' 个条目 · '+edges.length+' 条关系';
  nodeById.clear(); nodes.forEach(node => nodeById.set(node.id, node));
  if (!sameProject) { historyScope(snapshot.project.id);window.dispatchEvent(new CustomEvent('cewen:archive-filter',{detail:false}));get('toggle-archived').textContent='显示已归档';get('toggle-archived').setAttribute('aria-pressed','false');readingReady = false; clearTimeout(readingTimer); Object.assign(state, { selected: null, relationIndex: null, group: null, query: '', directOnly: false, mode: overviewMode, scopeIds: null, includeArchived: false }); analysisOrigin = null; }
  else {
    if (state.selected && !nodeById.has(state.selected)) state.selected = null;
    if (state.group && !groups.some(group => group.id === state.group)) state.group = null;
    const index = edges.findIndex(edge => edge.id === relationId);
    state.relationIndex = index < 0 ? null : index;
  }
  get('project-name').textContent = snapshot.project.name;
  if (isWebEdition) get('edition-state').textContent = snapshot.project.path.startsWith('/app/') ? '网页版 · 浏览器示例存储' : '网页版 · 已授权本机文件夹';
  get('breadcrumb-project').textContent = snapshot.project.name;
  get('project-description').textContent = snapshot.project.description || '项目设置';
  document.querySelector('.project-art')!.innerHTML=projectIdentity(snapshot);
  document.title=snapshot.project.name+' · 策问';
  get('refresh-project').textContent = snapshot.project.isExample ? '虚构示例 · 刷新文件' : '本地文档 · 刷新文件';
  get('system-count').textContent = String(groups.length);
  document.querySelector('.system-list')!.innerHTML = `<button data-group="" class="group-button"><span class="all-systems">${icon('circle-dot')}</span><span>全部系统</span><small>${nodes.length}</small></button>${groups.map(group => `<button class="group-button" data-group="${group.id}"><span class="group-dot" style="--group-color:${categoryColor(group.color)}"></span><span>${escape(group.label)}</span><small>${nodes.filter(node => node.group === group.id).length}</small></button>`).join('')}`;
  document.querySelector('.legend')!.innerHTML = groups.map(group => `<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('');
  get('analysis-focus').innerHTML = `<option value="">请选择条目</option><optgroup label="游戏总纲">${nodes.filter(node=>!node.group).map(node=>`<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>${groups.map(group => `<optgroup label="${escape(group.label)}">${nodes.filter(node => node.group === group.id).map(node => `<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>`).join('')}`;
  (get('search') as HTMLInputElement).value = state.query;
  if (!sameProject || !graph) { graph?.dispose(); graph = undefined; get('graph-canvas').replaceChildren(); graph = mountGraph(); graph?.setState(state, { deferLayout: true }); graph?.setMode(state.mode); }
  else if (snapshot.historical || !graph.updateText(readingSnapshot)) graph.updateData(readingSnapshot);
  if(readingSnapshot!==snapshot)graph?.updateData(readingSnapshot);
  graph?.setActive(state.view === 'graph' && !documentDesktop?.visible);graph?.setEditable(!snapshot.historical);
  if (nodes.length > 500) get('announcement').textContent = '大项目总览先展示系统和文档。选择系统、搜索或点击条目展开规则，也可在筛选中展开全部。';
  get('project-save-state').textContent = snapshot.recoveryRequired ? '有未完成写入 · 请查看版本' : snapshot.diagnostics.length ? `${snapshot.diagnostics.length} 项待核对` : '文档与版本已同步';
  connectionError = '';
  updateSpaceNavigation(); sync(); refreshIcons();
  historyPanel.sync(snapshot);
  if (!sameProject&&!isTransientProject(snapshot.project.id)) { readingReady = false; void restoreReading().then(()=>editingSession?.recover()).catch(reportProjectError); }
  (get('edit-document') as HTMLButtonElement).disabled = Boolean(snapshot.historical);
  (get('new-document') as HTMLButtonElement).disabled = Boolean(snapshot.historical);
  if (snapshot.historical) get('project-save-state').textContent = `${snapshot.revisionLabel} · 历史只读`;
  renderEditingState();
  documentDesktop?.receive(snapshot);
}

/** 外部变化到来时只替换已读投影，正在编辑的原稿基准由工作面板独立保留。 */
async function refreshProject(verify = false) {
  if (!projectSnapshot) { await workbench.projects(); return; }
  if (projectSnapshot.historical) return;
  const id = projectSnapshot.project.id, snapshot = await readProject(id, verify);
  if (projectSnapshot?.project.id !== id) return;
  if (snapshot.fingerprint !== projectSnapshot.fingerprint || snapshot.revision !== projectSnapshot.revision || snapshot.recoveryRequired !== projectSnapshot.recoveryRequired || JSON.stringify(snapshot.diagnostics) !== JSON.stringify(projectSnapshot.diagnostics)) applyProject(snapshot);
  else if(!editingSession?.count)get('project-save-state').textContent = snapshot.recoveryRequired ? '有未完成写入 · 请查看版本' : snapshot.diagnostics.length ? `${snapshot.diagnostics.length} 项待核对` : '文档与版本已同步';
}
function reportProjectError(error: unknown) { connectionError = error instanceof Error ? error.message : '本地项目操作未完成。'; get('project-save-state').textContent = connectionError; get('announcement').textContent = connectionError; renderInspector(); }

editingSession=new EditingSession(snapshot=>applyProject(snapshot,true),message=>{get('project-save-state').textContent=message;get('announcement').textContent=message;renderEditingState();});
if(projectSnapshot)editingSession.receive(projectSnapshot);
const workbench = new ProjectWorkbench(() => projectSnapshot, applyProject);
projectDirectory=new ProjectDirectory(get('project-directory-host'),{getSnapshot:()=>projectSnapshot!,includeArchived:()=>state.includeArchived,getSelected:()=>state.selected,getQuery:()=>state.query,getGroup:()=>state.group,onSelect:id=>selectNode(id),onGroup:group=>{state.group=group||null;state.scopeIds=null;sync();},onQuery:query=>{state.query=query;state.scopeIds=null;sync();},onCommit:applyProject,onError:message=>reportProjectError(new Error(message))});
if(projectSnapshot){document.querySelector('.project-art')!.innerHTML=projectIdentity(projectSnapshot);get('project-description').textContent=projectSnapshot.project.description||'项目设置';}
/** 结构草稿和正文保存共享同一个事务入口；布局始终只进入项目的私有工作区。 */
const editBar=document.createElement('div');editBar.className='graph-draft-actions';editBar.id='graph-draft-actions';editBar.innerHTML='<button data-graph-command="undo" title="Ctrl+Z">撤销</button><button data-graph-command="redo" title="Ctrl+Y">重做</button><button data-graph-command="save" title="Ctrl+S">保存结构版本</button><button data-graph-command="reset-layout">自动排布</button><label><input id="shake-links" type="checkbox"/>晃动断开普通关联</label><span id="structure-state"></span>';document.querySelector('.space-intro')!.after(editBar);
let canvasClipboard:{project:string;ids:string[];cut:boolean}|undefined;
function renderEditingState(){const bar=document.getElementById('graph-draft-actions');if(!bar)return;bar.hidden=!projectSnapshot||!!projectSnapshot.historical;for(const id of ['edit-document','new-document','project-center','project-switch','project-history']){const control=document.getElementById(id) as HTMLButtonElement|null;if(control)control.disabled=!!editingSession?.busy||(['edit-document','new-document'].includes(id)&&!!projectSnapshot?.historical);}const count=editingSession?.count??0;get('structure-state').textContent=count?`${count} 份文档待保存`:state.mode==='galaxy'?'拖动仅调整摆放':state.mode==='layers'?'按分类连续阅读 · 选中查看关联':'实线归属 · 虚线关联';for(const action of ['undo','redo','save']){const b=bar.querySelector<HTMLButtonElement>(`[data-graph-command="${action}"]`)!;b.disabled=action==='undo'?!editingSession?.canUndo:action==='redo'?!editingSession?.canRedo:!count;}const shake=bar.querySelector('label')!;shake.hidden=state.mode==='galaxy';if(count&&!projectSnapshot?.historical)get('project-save-state').textContent=`${count} 份文档有结构草稿 · Ctrl+S 保存版本`;}
async function finishGraphGesture(edit:GraphEdit|undefined,before:unknown,after:unknown){
  const current=graph,projectId=projectSnapshot?.project.id;if(!current||!editingSession)return;
  const restore=(value:unknown)=>{if(graph===current&&projectSnapshot?.project.id===projectId){current.restoreEditingLayout(value);sync();}};
  try{
    if(edit?.kind==='connect'){const type=await chooseRelationType();if(!type){restore(before);return;}edit={...edit,type};}
    if(edit?.kind==='insert'){const answer=await chooseAction('在普通关联中插入此条目',[{id:'insert',label:'替换为经过此条目的两条关联'},{id:'layout',label:'只调整摆放，保留原关联'}]);if(!answer){restore(before);return;}if(answer==='layout')edit=undefined;}
    if(graph!==current||projectSnapshot?.project.id!==projectId)return;
    if(edit&&projectSnapshot){const result=graphChanges(projectSnapshot,edit);const locked=result.changes.find(change=>projectSnapshot?.documents.some(doc=>doc.path===change.path&&projectSnapshot?.collaboration?.locks[doc.id]));if(locked)throw new Error('LLM 正在编写关联文档，请停止任务后修改。');}
    if(edit)editingSession.apply(edit,()=>restore(before),()=>restore(after));else editingSession.layout(()=>restore(before),()=>restore(after));sync();
  }catch(error){restore(before);throw error;}
}
async function graphCommand(command:string,id=state.selected){
  if(!projectSnapshot||projectSnapshot.historical)return;let edit:GraphEdit|undefined;
  const selected=id?[id]:graph?.selectedIds()??[],ids=id&&id!==state.selected?selected:graph?.selectedIds().length?graph.selectedIds():selected;
  if(command==='selectAll'){graph?.selectAllNodes();return;}if(command==='search'){setSidebarExpanded(true);document.querySelector<HTMLInputElement>('.project-directory-top input')?.focus();return;}
  if(command==='save'){try{await editingSession?.save();}finally{renderEditingState();}return;}if(command==='undo'){editingSession?.undo();sync();return;}if(command==='redo'){editingSession?.redo();sync();return;}
  if(command==='reset-layout'){const before=graph?.exportLayout();graph?.resetPositions();const after=graph?.exportLayout();await finishGraphGesture(undefined,before,after);return;}
  if(command==='classify')edit=await classifyDocuments(projectSnapshot,ids.filter(value=>{const node=nodeById.get(value);return node?.kind==='rule'&&!!node.anchor||node?.kind==='document'&&node.documentType!=='gdd';}));
  if(command==='connect'&&id)edit=await connectDocuments(projectSnapshot,id);
  if(command==='edge'&&state.relationIndex!==null)edit=await editEdge(projectSnapshot,edges[state.relationIndex].id);
  if(command==='copy'||command==='cut'){const documents=[...new Set(ids.map(value=>nodeById.get(value)).filter(n=>n?.kind!=='system'&&n?.documentType!=='gdd').map(n=>n!.documentId))];if(!documents.length)return;canvasClipboard={project:projectSnapshot.project.id,ids:documents,cut:command==='cut'};await navigator.clipboard.writeText(documents.map(value=>nodeById.get(value)?.title??'').join('\n')).catch(()=>{});get('announcement').textContent=command==='cut'?'已剪切条目；选中目标分类后粘贴即可移动归属。':'已复制条目；在当前项目粘贴可创建独立副本。';return;}
  if(command==='paste'&&canvasClipboard){if(canvasClipboard.project!==projectSnapshot.project.id)throw new Error('文档复制暂限当前项目，跨项目请使用导出与导入。');const group=nodeById.get(state.selected??'')?.group??state.group??'system-unassigned';edit=canvasClipboard.cut?{kind:'classify',ids:canvasClipboard.ids,group}:{kind:'clone',ids:canvasClipboard.ids,group};}
  if(edit){const result=graphChanges(projectSnapshot,edit);if(result.changes.some(change=>projectSnapshot?.documents.some(doc=>doc.path===change.path&&projectSnapshot?.collaboration?.locks[doc.id])))throw new Error('LLM 正在编写关联文档，请停止任务后修改。');editingSession?.apply(edit);}
}
document.addEventListener('click',event=>{const b=(event.target as HTMLElement).closest<HTMLElement>('[data-graph-command]');if(b)void graphCommand(b.dataset.graphCommand!).catch(reportProjectError);});
get('shake-links').addEventListener('change',event=>graph?.setShake((event.target as HTMLInputElement).checked));
window.addEventListener('cewen:editing-command',event=>{if(event.defaultPrevented||documentDesktop?.visible||document.querySelector('dialog[open]')||document.activeElement?.matches('input,textarea,select,[contenteditable=true]'))return;const command=(event as CustomEvent<string>).detail;if(['save','undo','redo','cut','copy','paste','selectAll'].includes(command)){event.preventDefault();void graphCommand(command).catch(reportProjectError);}});
/** 上下文菜单在当前画布旁出现；所有操作回到同一编辑与保存流程。 */
const graphMenu=document.createElement('div');graphMenu.className='star-context-menu';graphMenu.hidden=true;graphMenu.setAttribute('aria-label','星图快捷操作');document.body.append(graphMenu);
const closeGraphMenu=()=>{graphMenu.hidden=true;graph?.setContextMenuOpen(false);};
function openGraphMenu(detail:{id?:string;x:number;y:number}){
  if(!projectSnapshot)return;const node=detail.id?nodeById.get(detail.id):undefined;
  const actions=projectSnapshot.historical?[['latest','回到最新版本']]:node?.kind==='system'?[['dd','在此分类新建 DD'],['category','修改分类'],['question','记录设计问题']]:node?[['edit','打开写作'],['dd','新建专项设计'],['connect','添加手工关联'],['pin','固定 / 解除固定位置'],['category-document','更改文档分类'],['annotation','批注与标记'],['prompt','让 LLM 深挖']]:[['dd','新建专项设计 DD'],['gdd','编写游戏总纲'],['question','记录设计问题'],['category','新建设计分类'],['prompt','与 LLM 一起构思']];
  graphMenu.innerHTML=`<small>${escape(node?.title??'在星图中开始')}</small>${actions.map(([action,label])=>`<button data-star-action="${action}">${label}</button>`).join('')}`;graphMenu.hidden=false;
  graphMenu.style.left=`${Math.max(8,Math.min(detail.x,innerWidth-graphMenu.offsetWidth-8))}px`;graphMenu.style.top=`${Math.max(8,Math.min(detail.y,innerHeight-graphMenu.offsetHeight-8))}px`;graph?.setContextMenuOpen(true);
  graphMenu.onclick=event=>{const action=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-star-action]')?.dataset.starAction;if(!action)return;closeGraphMenu();void(async()=>{switch(action){case 'dd':await workbench.newDocument(node?.group??state.group??'','dd',node?.kind==='document'&&node.documentType==='dd'?node.id:undefined);break;case 'gdd':await workbench.newDocument('','gdd');break;case 'question':await workbench.newDocument(node?.group??'','question');break;case 'category':await workbench.categories(node?.kind==='system'?node.id:'');break;case 'pin':{const before=graph?.exportLayout();graph?.togglePin(node!.id);await finishGraphGesture(undefined,before,graph?.exportLayout());break;}case 'category-document':await graphCommand('classify',node?.id);break;case 'connect':await graphCommand('connect',node?.id);break;case 'edit':if(node?.documentId)documentDesktop?.openDocument(node.documentId,true);break;case 'annotation':await workspacePanel.open(node?.id??'');break;case 'prompt':await openCollaboration(node?'inquiry':'start',projectSnapshot,node?.documentId?[node.documentId]:[]);break;case 'latest':applyProject(await readProject(projectSnapshot!.project.id));break;}})().catch(reportProjectError);};
  graphMenu.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
}
window.addEventListener('cewen:graph-context',event=>openGraphMenu((event as CustomEvent).detail));
document.addEventListener('pointerdown',event=>{if(!graphMenu.contains(event.target as Node))closeGraphMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeGraphMenu();});
window.addEventListener('resize',closeGraphMenu);
const graphCreate=document.createElement('button');graphCreate.className='secondary-button graph-create-button';graphCreate.textContent='＋ 新建';get('graph-canvas').parentElement!.append(graphCreate);graphCreate.addEventListener('click',()=>{const box=graphCreate.getBoundingClientRect();openGraphMenu({x:box.left,y:box.top-190});});
const collaborationButton=document.createElement('button');collaborationButton.className='secondary-button';collaborationButton.dataset.tutorial='llm-collaboration';collaborationButton.textContent='与 LLM 协作';document.querySelector('.project-toolbar')!.append(collaborationButton);collaborationButton.addEventListener('click',()=>void openCollaboration(state.selected?'inquiry':'start',projectSnapshot,state.selected?[nodeById.get(state.selected)!.documentId].filter(Boolean):[]));
window.addEventListener('cewen-theme-change',()=>{renderDirectory();renderInspector();renderCards();document.querySelectorAll<HTMLElement>('.system-list [data-group]').forEach(button=>{const group=groups.find(group=>group.id===button.dataset.group),dot=button.querySelector<HTMLElement>('.group-dot');if(group&&dot)dot.style.setProperty('--group-color',categoryColor(group.color));});document.querySelector('.legend')!.innerHTML=groups.map(group=>`<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('');});
const historyPanel = new HistoryPanel(() => projectSnapshot, applyProject);
const workspacePanel = new WorkspacePanel(() => projectSnapshot, selectNode, item => workbench.publishAnnotation(item), (ids, title) => { state.scopeIds = ids; state.selected = null; state.relationIndex = null; sync(); get('announcement').textContent = `正在查看关联条目：${title}。全部分类可返回全部。`; }, () => ({ ...state }), restoreReadingState, applyProject);
/** 顶边框的视图菜单与原阅读视图保存流程共用同一入口。 */
window.addEventListener('cewen:save-reading-view', () => { void workspacePanel.saveCurrentView().catch(reportProjectError); });
/** 阅读状态与稳定坐标从工作区恢复，不介入公开文档历史。 */
function restoreReadingState(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const saved = value as Partial<typeof state>;
  state.query = typeof saved.query === 'string' ? saved.query : ''; state.group = groups.some(group => group.id === saved.group) ? saved.group! : null; state.scopeIds = Array.isArray(saved.scopeIds) ? saved.scopeIds.filter(id => nodeById.has(id)) : null; state.includeArchived = saved.includeArchived === true; state.detailedGraph = saved.detailedGraph === true;
  state.selected = saved.selected && nodeById.has(saved.selected) ? saved.selected : null;
  state.directOnly = saved.directOnly === true; state.labelsAll = saved.labelsAll === true; state.paused = saved.paused === true;
  get('toggle-labels').setAttribute('aria-pressed', String(state.labelsAll));
  get('toggle-motion').setAttribute('aria-pressed', String(state.paused));
  if (!documentDesktop?.visible && saved.view && ['graph','document','cards'].includes(saved.view)) setView(saved.view);
  state.direction = saved.direction === 'horizontal' ? 'horizontal' : 'vertical';graph?.setDirection(state.direction);
  if (saved.mode === 'galaxy' || saved.mode === 'layers' || saved.mode === 'mindmap') setGraphMode(saved.mode);
  (get('search') as HTMLInputElement).value = state.query; sync();
}
async function restoreReading() {
  if (!projectSnapshot) { readingReady = true; return; }
  const id = projectSnapshot.project.id, saved = await projectAction<{ state?: unknown; layout?: unknown; recent?: string[] } | null>(id, 'reading-view');
  if (projectSnapshot.project.id !== id) return;
  if (saved) { graph?.restoreLayout(saved.layout); recentNodes = Array.isArray(saved.recent) ? saved.recent.filter(node => nodeById.has(node)) : []; restoreReadingState(saved.state); }
  const match = /^#cewen-doc=(.+)$/.exec(location.hash); if (match) { const nodeId = decodeURIComponent(match[1]); if (nodeById.has(nodeId)) { selectNode(nodeId); setView('document'); } }
  readingReady = true;
}
/** 教程菜单集中清理监听器，重开或键盘关闭不会留下游离监听。 */
let closeTutorialMenu: (()=>void) | undefined;
function openTutorialMenu() {
 if(closeTutorialMenu){closeTutorialMenu();return;}
 const menu=document.createElement('div');menu.id='tutorial-menu';menu.className='tutorial-menu';menu.setAttribute('role','dialog');menu.setAttribute('aria-label','教程中心');
 const states:Record<string,string>={running:'可继续',paused:'已暂停',completed:'已完成',skipped:'已跳过',partial:'部分跳过'};
 menu.innerHTML=`<header><strong>教程中心</strong><button data-close aria-label="关闭">×</button></header><p>普通导览只阅读；操作练习会核对实际完成动作，必须使用独立虚构副本。练习进度与导览分开。</p><div class="tutorial-list">${tutorialManager.available().map(item=>`<div class="tutorial-item"><button data-tutorial-id="${item.id}"><span><strong>${item.title}</strong><small>${item.steps} 步 · ${states[item.progress?.status??'']??'未开始'}</small></span><b>${['running','paused'].includes(item.progress?.status??'')?'继续':'开始'}</b></button><button data-replay="${item.id}" aria-label="重新开始${item.title}">重来</button></div>`).join('')}</div><button class="tutorial-reset" data-reset>重置所有教程记录</button>`;
 document.body.append(menu);const anchor=get('tutorial-help').getBoundingClientRect();menu.style.top=`${anchor.bottom+8}px`;menu.style.right=`${Math.max(8,innerWidth-anchor.right)}px`;
 const close=()=>{menu.remove();document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);closeTutorialMenu=undefined;get('tutorial-help').focus();};
 const outside=(e:PointerEvent)=>{if(!menu.contains(e.target as Node)&&!(e.target as HTMLElement).closest('#tutorial-help'))close();};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close();}};
 closeTutorialMenu=close;document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
 menu.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b)return;if(b.hasAttribute('data-close'))return close();if(b.hasAttribute('data-reset')){tutorialManager.reset();close();openTutorialMenu();return;}const id=b.dataset.tutorialId??b.dataset.replay;if(id){close();if(id.endsWith('-practice')&&(!projectSnapshot||!isPracticeProject(projectSnapshot.project.id))){openExampleHub({practice:true,onCreated:next=>{applyProject(next);setPracticeProject(next.project.id);void tutorialManager.start(id,0);}});}else void tutorialManager.start(id,b.dataset.replay?0:undefined);}};
 menu.querySelector<HTMLButtonElement>('button')?.focus();
}

const collaborationPanel = new CollaborationPanel(() => projectSnapshot, applyProject);
creativeWorkspace=new CreativeWorkspace(get('creative-view'),applyProject,()=>void collaborationPanel.open('proposals').catch(reportProjectError));
if(projectSnapshot)creativeWorkspace.receive(projectSnapshot);
window.addEventListener('cewen:creative-apply',event=>applyProject((event as CustomEvent<ProjectSnapshot>).detail));
window.addEventListener('cewen:tutorial-navigation',event=>{const d=(event as CustomEvent).detail;if(!['objects','quests','sequences','production','presets'].includes(d?.tab))return;setView('creative');creativeWorkspace?.tutorialNavigate(d.tab,d.type);});
window.addEventListener('cewen:creative-request',event=>{const detail=(event as CustomEvent).detail;if(documentDesktop&&!projectSnapshot?.historical){void documentDesktop.handleCreative(detail).catch(reportProjectError);return;}if(detail.action==='new-project'){void openPresetDialog(undefined,applyProject).catch(reportProjectError);return;}if(!['creative','quest','animatic'].includes(state.view))setView('creative');void creativeWorkspace?.handle(detail).catch(reportProjectError);});
// 启动链接项目的分类模型已就绪，图谱与阅读内容初始化属于真实内容阶段。
if(startupLoading){startupLoading.stage('content','准备项目内容与关系视图');await startupLoading.paint();}
graph = mountGraph();
sync();
void restoreReading().then(()=>editingSession?.recover()).catch(reportProjectError);
refreshIcons();
if (projectSnapshot && tutorialManager.shouldAutoStart('first-launch')) window.setTimeout(() => { void tutorialManager.start('first-launch'); }, 700);
document.querySelector('.brand')!.addEventListener('click',()=>documentDesktop?.askQuestions());
documentDesktop=new DocumentDesktop({includeArchived:()=>state.includeArchived,apply:applyProject,document:()=>{app.classList.add('document-canvas-open');state.view='document';for(const id of ['graph-view','cards-view','reading-view','creative-view','inspector'])get(id).hidden=true;graph?.setActive(false);get('view-title').textContent='策划案';document.querySelectorAll('.main-nav [data-view]').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.view==='document'));},graph:(mode,id)=>{app.hidden=false;setView('graph');if(mode)setGraphMode(mode);if(id)enterAnalysis(id);},history:()=>void historyPanel.open().catch(reportProjectError),connections:()=>get('llm-connection').click(),proposals:()=>void collaborationPanel.open('proposals'),legacyAction:detail=>{documentDesktop!.root.hidden=true;app.hidden=false;setView('creative');void creativeWorkspace?.handle(detail).catch(reportProjectError);}});
// 从星图或卡片库进入策问时仅临时改变主视图；退出恢复原视图与仍挂载的滚动位置。
setConnectorTakeoverGuard(()=>!documentDesktop?.hasUnsavedChanges&&!editingSession?.count&&!editingSession?.busy&&!editingSession?.canUndo);
initializeConnectorPanel();
if(projectSnapshot)onConnectorProject(projectSnapshot);
/** 配对后重新取得真实项目路径与正式快照，再释放旧订阅以连接本机事件服务。 */
window.addEventListener('cewen:connector-paired',event=>{const session=(event as CustomEvent<ConnectorSession>).detail;if(projectSnapshot?.project.id!==session.projectId)return;disposeLive?.();disposeLive=undefined;liveProject='';void readProject(session.projectId).then(snapshot=>{if(projectSnapshot?.project.id===session.projectId)applyProject(snapshot);}).catch(reportProjectError);});
documentDesktop.setReadingReturnFactory(()=>{const view=state.view;return ()=>{app.hidden=false;setView(view);};});
/** 保留原面板骨架，把重复品牌行和项目工具行合入紧凑应用栏。 */
const titleContent=document.querySelector('.desktop-titlebar-content');
if(titleContent){
  titleContent.prepend(document.querySelector('.application-bar .brand')!);
  titleContent.append(document.querySelector('.application-actions')!);
}
const projectMore=document.createElement('button');projectMore.className='secondary-button project-more';projectMore.textContent='项目 ⋯';
const compactActions=[['edit-document','编辑当前文档'],['project-statistics','项目统计'],['project-history','版本历史'],['organize-project','整理项目'],['project-inquiry','问询项目'],['project-exchange','导入与导出'],['refresh-project','重新扫描文件']];
projectMore.onclick=()=>showAppMenu(compactActions.map(([id,label])=>({label,run:()=>get(id).click()})),projectMore);
document.querySelector('.project-toolbar')!.append(projectMore);
for(const [id] of compactActions)get(id).classList.add('compact-project-action');
app.hidden=true;
window.addEventListener('cewen:relation-preview',e=>{if(documentDesktop)documentDesktop.root.hidden=true;setView('graph');enterAnalysis((e as CustomEvent<string>).detail);});
window.addEventListener('cewen:open-project',e=>void documentDesktop!.open((e as CustomEvent<ProjectSnapshot>).detail).catch(reportProjectError));
window.addEventListener('cewen:request-save-as',()=>void documentDesktop!.saveAs().catch(reportProjectError));
document.querySelectorAll<HTMLElement>('[data-view="creative"],[data-view="quest"],[data-view="animatic"]').forEach(el=>el.remove());

if(projectSnapshot)void documentDesktop.open(projectSnapshot,false,startupLoading).catch(reportProjectError).finally(()=>{startupLoading?.finish();startupLoading=undefined;});
/** 聚焦和定期扫描补足外部保存；后续监听仍需沿用相同哈希核对。 */
let refreshing = false;
const scan = () => { if (refreshing || !projectSnapshot || document.hidden || documentDesktop?.isHome || isTransientProject(projectSnapshot.project.id)) return; refreshing = true; void refreshProject().catch(reportProjectError).finally(() => { refreshing = false; }); };
window.addEventListener('focus', scan);
setInterval(scan, 4000);
// 浏览器把页面暂存到前进后退缓存时保留场景；真正卸载时才释放显卡资源。
window.addEventListener('pagehide', event => {
  if (event.persisted) graph?.setActive(false);
  else { tutorialManager.dispose();closeTutorialMenu?.();creativeWorkspace?.deactivate();graph?.dispose(); connectionPanel.dispose(); }
});
window.addEventListener('pageshow', event => { if (event.persisted) graph?.setActive(state.view === 'graph'); });
