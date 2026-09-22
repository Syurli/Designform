import './style.css';
import './workbench.css';
import './features.css';
import './theme.css';
import './shell.css';
import './authoring.css';
import { categoryColor } from './category-color';
import { openCollaboration } from './prompt-panel';
import { initializeTheme, mountDesktopChrome } from './theme';
import { createIcons, Orbit, Network, Layers, FileText, LayoutGrid, Search, ChevronRight, ArrowUpRight, X, Focus, Plus, Minus, Sparkles, ArrowLeft, CircleDot, PanelLeft } from 'lucide';
import { KnowledgeGraph, type GraphMode } from './graph';
import { nodes, edges, groups, types, setKnowledgeData, type KnowledgeNode, type ProjectSnapshot } from './data';
import { edgeSentence } from './analysis';
import { projectAction, connectProjects, readProject } from './project-client';
import { ProjectWorkbench } from './workbench';
import { HistoryPanel } from './history-panel';
import { WorkspacePanel } from './workspace-panel';
import { CollaborationPanel } from './collaboration-panel';
import { projectMarkdown, installReadingPreviews } from './document-reading';
import { ConnectionPanel } from './connection-panel';
import { isWebEdition } from './edition';

/** 启动时读取独立项目目录；没有最近项目则进入项目中心，不自动接入真实资料。 */
let projectSnapshot: ProjectSnapshot | undefined;
let connectionError = '';
try {
  const library = await connectProjects();
  const linkedProject = new URL(location.href).searchParams.get('project');
  if (linkedProject && library.projects.some(project => project.id === linkedProject)) projectSnapshot = await readProject(linkedProject);
  else if (library.current) projectSnapshot = await readProject(library.current);
  if (projectSnapshot) setKnowledgeData(projectSnapshot);
} catch (error) { connectionError = error instanceof Error ? error.message : '本地项目服务暂不可用。'; }

/** 阅读状态与文档编辑数据分开，不把镜头与筛选写入策划正文。 */
type View = 'graph' | 'document' | 'cards';
type OverviewMode = Exclude<GraphMode, 'network'>;
/** 分析是知识空间内的次级阅读页，返回时恢复进入前的选择及筛选。 */
type AnalysisOrigin = { mode: OverviewMode; selected: string | null; group: string | null; query: string; directOnly: boolean };
let analysisOrigin: AnalysisOrigin | null = null;
let overviewMode: OverviewMode = 'galaxy';
const state = { view: 'graph' as View, mode: 'galaxy' as GraphMode, selected: null as string | null, relationIndex: null as number | null, group: null as string | null, query: '', directOnly: false, labelsAll: false, paused: false, scopeIds: null as string[] | null, includeArchived: false, detailedGraph: false };
const nodeById = new Map(nodes.map(node => [node.id, node]));
const app = document.getElementById('app')!;
const closeReadingPreview = installReadingPreviews(() => projectSnapshot);
window.addEventListener('cewen:read-document', event => {
  const id = (event as CustomEvent<string>).detail; if (!nodeById.has(id)) return;
  state.scopeIds = null; selectNode(id); setView('document');
  const node = nodeById.get(id)!;
  const anchor = node.anchor && get('reading-view').querySelector(`#doc-${CSS.escape(node.documentId)} [id="${CSS.escape(node.anchor)}"]`);
  if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'instant' }); else get('reading-view').scrollTop = 0;
});
/** 阅读回退只保存当前阅读位置，不写入策划正文或版本。 */
const readingTrail: { selected: string | null; scroll: number; group: string | null; scopeIds: string[] | null; query: string }[] = [];
const names = { galaxy: '星图总览', network: '关系分析', layers: '系统分层' };
const kindNames = { system: '系统', document: '专项文档', rule: '设计规则' };
const statusNames = { confirmed: '已确认', draft: '草稿', question: '待确认', archived: '已归档' };
const icons = { Orbit, Network, Layers, FileText, LayoutGrid, Search, ChevronRight, ArrowUpRight, X, Focus, Plus, Minus, Sparkles, ArrowLeft, CircleDot, PanelLeft };

/** 所有来自资料的数据进入 HTML 前转义，后续接入导入功能时也不执行文档中的标签。 */
function escape(text: string) { return text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!)); }
function icon(name: string) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }
function refreshIcons() { createIcons({ icons, attrs: { 'stroke-width': 1.65 } }); }
function sourceName(source: string) { return source.split('/').at(-1) || source; }
function groupOf(node: KnowledgeNode) { return groups.find(group => group.id === node.group)!; }
function status(node: KnowledgeNode) { return `<span class="status ${node.status}">${statusNames[node.status]}</span>`; }

/** 固定的工作台框架只创建一次，切换模式保留同一个 WebGL 画布。 */
app.innerHTML = `
  <header class="application-bar" aria-label="策问应用功能">
    <a class="brand" href="./" aria-label="策问 Designform 首页"><span class="brand-name"><span class="brand-mark"><img data-brand-icon src="${import.meta.env.BASE_URL}icons/cewen-dark.svg" alt="策"/></span><b>问</b></span><small class="brand-wordmark">Designform</small></a>
    <span class="application-divider"></span><button class="application-projects" id="project-center">${icon('layout-grid')}项目库</button>
    <span class="application-tagline">把想法写成游戏</span>
    <div class="application-actions"><button class="llm-connection" id="llm-connection" aria-label="LLM 连接状态"><span class="connection-dot"></span><span><strong>正在检查连接</strong><small>LLM 协作</small></span></button><button class="theme-toggle icon-button" data-theme-toggle aria-label="切换浅色主题"></button></div>
  </header>
  <button class="sidebar-scrim" id="sidebar-scrim" aria-label="收起项目目录"></button>
  <aside class="sidebar" aria-label="当前项目文档目录">
    <button class="icon-button sidebar-close" id="sidebar-close" aria-label="关闭系统目录">${icon('x')}</button>
    <div class="project-label">当前项目</div>
    <button class="project project-opener" id="project-switch" aria-label="切换当前项目"><span class="project-art">${icon('file-text')}</span><span><strong id="project-name">${escape(projectSnapshot?.project.name ?? '选择项目')}</strong><small id="project-description">${projectSnapshot?.project.isExample ? '虚构基础示例' : '独立文档 · 本地保存'}</small></span>${icon('chevron-right')}</button>
    <label class="search-box">${icon('search')}<input id="search" type="search" placeholder="搜索标题、规则…" autocomplete="off" aria-label="搜索策划内容"/><kbd>/</kbd></label>
    <details class="system-filter"><summary><span id="system-filter-label">全部系统</span><small><span id="system-count">${groups.length}</span> 个系统</small></summary>
    <div class="system-list">
      <button data-group="" class="group-button active"><span class="all-systems">${icon('circle-dot')}</span><span>全部系统</span><small>${nodes.length}</small></button>
      ${groups.map(group => `<button class="group-button" data-group="${group.id}"><span class="group-dot" style="--group-color:${categoryColor(group.color)}"></span><span>${escape(group.label)}</span><small>${nodes.filter(node => node.group === group.id).length}</small></button>`).join('')}
    </div>
    </details>
    <details class="reading-options"><summary>筛选与阅读记录</summary><button id="toggle-archived">显示已归档内容</button><label class="mini-check"><input id="detailed-graph" type="checkbox"/>大型图谱展开全部规则</label><button id="recent-reading">最近浏览</button><button id="save-reading-view">保存当前阅读视图</button><button id="reset-reading-filters">清除所有筛选</button></details>
    <div class="sidebar-section entry-heading"><span id="entry-heading">策划条目</span><span id="entry-count"></span></div>
    <div id="node-directory" class="node-directory" aria-label="可选择的策划条目"></div>
    <footer class="sidebar-footer"><span>文档目录</span><span>A BAIGE PROJECT</span></footer>
  </aside>
  <div class="workspace">
    <header class="topbar">
      <div class="workspace-navigation"><button class="icon-button menu-button" id="menu-toggle" aria-label="展开或收起项目目录" aria-expanded="false">${icon('panel-left')}</button><nav class="main-nav" aria-label="查看方式"><button data-view="graph" class="active">${icon('orbit')}知识空间</button><button data-view="document">${icon('file-text')}策划案</button><button data-view="cards">${icon('layout-grid')}卡片库</button></nav><div class="breadcrumb"><span id="breadcrumb-project">${escape(projectSnapshot?.project.name ?? '策问')}</span>${icon('chevron-right')}<strong id="view-title">知识空间</strong></div></div>
      <div class="project-toolbar" aria-label="当前项目操作"><button class="secondary-button" id="new-document">${icon('plus')}新建文档</button><button class="secondary-button" id="edit-document">编辑</button><span></span><button class="secondary-button" id="project-history">版本</button><button class="secondary-button" id="organize-project">整理</button><button class="secondary-button" id="project-inquiry">问询</button><button class="secondary-button" id="project-exchange">交换</button><button class="sample-tag" id="refresh-project" title="重新扫描外部文档修改">${projectSnapshot?.project.isExample ? '虚构示例 · 刷新文件' : '本地文档 · 刷新文件'}</button></div>
    </header>
    <main class="work-area">
      <section class="graph-view" id="graph-view" aria-label="知识空间">
        <header class="space-toolbar">
          <div class="space-heading"><button class="analysis-back" id="back-to-overview" hidden>${icon('arrow-left')}<span>返回星图总览</span></button><span class="eyebrow" id="space-eyebrow">KNOWLEDGE SPACE</span><h1><span id="space-title">设计星图</span><span id="space-count"></span></h1></div>
          <div class="mode-switch" id="overview-switch" role="group" aria-label="总览布局">
            <button data-mode="galaxy" aria-pressed="true" class="active">${icon('orbit')}星图总览</button>
            <button data-mode="layers" aria-pressed="false">${icon('layers')}系统分层</button>
          </div>
          <span class="analysis-page-note" id="analysis-page-note" hidden>从一个条目，读懂它的直接联系</span>
        </header>
        <div class="space-intro" id="space-intro">在系统之间，发现设计的联系</div>
        <div class="analysis-toolbar" id="analysis-toolbar" hidden><label>分析焦点<select id="analysis-focus" aria-label="选择关系分析焦点"><option value="">请选择条目</option>${groups.map(group => `<optgroup label="${escape(group.label)}">${nodes.filter(node => node.group === group.id).map(node => `<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>`).join('')}</select></label><span>建议复核 ≠ 必须修改 · 点击连线查看依据</span></div>
        <div id="graph-canvas" class="graph-canvas"></div>
        <div class="graph-empty" id="graph-empty" hidden><strong id="graph-empty-title">没有匹配的条目</strong><p id="graph-empty-description">尝试其他关键词，或清除当前筛选。</p><button class="secondary-button" id="clear-filters">清除筛选</button></div>
        <div class="graph-tools"><button class="tool-button" id="reset-view" aria-label="返回全图">${icon('focus')}<span>全图</span></button><span class="tool-divider"></span><button class="icon-button" id="zoom-in" aria-label="放大关系图">${icon('plus')}</button><button class="icon-button" id="zoom-out" aria-label="缩小关系图">${icon('minus')}</button><span class="tool-divider"></span><button class="tool-button" id="toggle-labels" aria-pressed="false">标签</button><button class="tool-button" id="toggle-motion" aria-pressed="false" title="暂停关联线上的方向粒子">静止</button></div>
        <div class="space-bottom"><div class="legend">${groups.map(group => `<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('')}</div><span class="gesture" id="gesture">拖动旋转 · 滚轮缩放 · 点击阅读</span></div>
      </section>
      <section class="reading-view" id="reading-view" hidden aria-label="策划案阅读"></section>
      <section class="cards-view" id="cards-view" hidden aria-label="策划卡片库"></section>
      <aside class="inspector" id="inspector" aria-label="条目与关系详情"></aside>
    </main>
    <footer class="workspace-footer"><span id="edition-state"><i></i>策问 · ${isWebEdition ? '网页版 · 本机文件' : '本地工作台'}</span><span id="footer-count">${nodes.length} 个条目 · ${edges.length} 条关系</span><span id="project-save-state">${projectSnapshot ? '文档已同步' : '尚未打开项目'}</span></footer>
  </div>
  <div class="announcement" id="announcement" role="status" aria-live="polite"></div>`;

mountDesktopChrome();
await initializeTheme();

let graph: KnowledgeGraph | undefined;
let readingReady = false;
let readingTimer: ReturnType<typeof setTimeout> | undefined;
let recentNodes: string[] = [];
const get = (id: string) => document.getElementById(id)!;
const connectionPanel = new ConnectionPanel(get('llm-connection') as HTMLButtonElement, () => projectSnapshot);
/** 目录展开状态按项目保留在本次阅读中，不修改任何策划文档。 */
const directoryExpansion = new Map<string, Set<string>>();

/** 图谱、卡片和目录共用同一搜索条件，避免“切换查看方式后资料消失”的语义差异。 */
function filteredNodes() {
  const query = state.query.trim().toLowerCase();
  const related = new Set([state.selected]);
  const filterRelated = state.directOnly && state.mode !== 'network';
  if (filterRelated && state.selected) edges.forEach(edge => { if (edge.source === state.selected) related.add(edge.target); if (edge.target === state.selected) related.add(edge.source); });
  return nodes.filter(node => (state.includeArchived || node.status !== 'archived') && (!state.scopeIds || state.scopeIds.includes(node.id)) && (!state.group || node.group === state.group) && (!query || `${node.id} ${node.title} ${node.summary} ${node.content.join(' ')}`.toLowerCase().includes(query)) && (!filterRelated || !state.selected || related.has(node.id)));
}

/** 关系分析始终围绕显式焦点，搜索只筛选候选目录，不悄悄删掉分析依据。 */
function renderAnalysisControls() {
  const analyzing = state.mode === 'network';
  get('overview-switch').hidden = analyzing;
  get('back-to-overview').hidden = !analyzing;
  get('back-to-overview').querySelector('span')!.textContent = `返回${names[analysisOrigin?.mode ?? overviewMode]}`;
  get('analysis-page-note').hidden = !analyzing;
  get('space-eyebrow').hidden = analyzing;
  get('view-title').textContent = state.view === 'graph' ? (analyzing ? '关系分析' : '知识空间') : state.view === 'document' ? '策划案' : '卡片库';
  get('analysis-toolbar').hidden = !analyzing;
  (get('analysis-focus') as HTMLSelectElement).value = state.selected ?? '';
  (get('search') as HTMLInputElement).placeholder = analyzing ? '搜索目录，选择分析条目…' : '搜索标题、规则…';
  get('space-title').textContent = analyzing ? '关系分析' : state.mode === 'layers' ? '系统分层' : '设计星图';
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
  refreshIcons();
}

function renderReading() {
  closeReadingPreview();
  const visible = filteredNodes();
  const selected = state.selected ? nodeById.get(state.selected) : undefined;
  const ids = new Set((selected ? [selected] : visible).map(node => node.documentId));
  const documents = projectSnapshot?.documents.filter(document => ids.has(document.id)).sort((a, b) => Number(b.type === 'gdd') - Number(a.type === 'gdd')) ?? [];
  get('reading-view').innerHTML = `<header class="reading-header"><span class="eyebrow">DESIGN DOCUMENTS</span><h1>${selected ? escape(selected.title) : escape(projectSnapshot?.project.name ?? '未命名项目') + ' · 策划案'}</h1><p>${projectSnapshot?.historical ? `${projectSnapshot.revisionLabel} · 历史策划` : '从设计正文开始阅读，悬停带下划线的词语可预览相关设计。'}</p><div class="reading-navigation">${readingTrail.length ? `<button class="text-button" id="reading-back">${icon('arrow-left')}返回上一处</button>` : ''}${selected ? `<button class="text-button" id="read-all">返回策划案总览</button>` : ''}</div></header><div class="document-content">${documents.map(document => `<article class="document-section" id="doc-${document.id}"><div class="markdown-preview">${projectMarkdown(document, projectSnapshot!)}</div><footer class="document-reading-footer"><div class="document-source">${escape(document.path)}</div><button class="text-button" data-locate="${document.id}">${icon('network')}在关系网中定位${icon('arrow-up-right')}</button></footer></article>`).join('') || '<div class="reading-empty">没有找到匹配文档。可以新建一份 GDD 或 DD。</div>'}</div>`;
  refreshIcons();
}

function renderCards() {
  const visible = filteredNodes();
  get('cards-view').innerHTML = `<header class="reading-header"><span class="eyebrow">DESIGN LIBRARY</span><h1>策划卡片<span class="title-count">${visible.length}</span></h1><p>每一张卡片，都与同一份知识空间相连。</p></header><div class="card-grid">${visible.map(node => `<button class="design-card ${node.id === state.selected ? 'selected' : ''}" data-node="${node.id}" style="--group-color:${categoryColor(groupOf(node).color)}"><span class="card-top"><span class="detail-group"><i></i>${escape(groupOf(node).label)}</span>${icon(node.kind === 'document' ? 'file-text' : 'circle-dot')}</span><h2>${escape(node.title)}</h2><p>${escape(node.summary)}</p><span class="card-bottom">${status(node)}<span>${kindNames[node.kind]}</span></span></button>`).join('') || '<div class="reading-empty">没有匹配的卡片，可清除搜索或系统筛选。</div>'}</div>`;
  refreshIcons();
}

/** 更新阅读内容而不重建场景；这个边界也是未来接入模型操作接口的位置。 */
function sync(updateGraph = true) {
  if (readingReady && projectSnapshot && !projectSnapshot.historical) { clearTimeout(readingTimer); const id = projectSnapshot.project.id; readingTimer = setTimeout(() => { void projectAction(id, 'reading-view', { state: { ...state }, layout: graph?.exportLayout(), recent: recentNodes }).catch(reportProjectError); }, 900); }
  renderAnalysisControls();
  renderDirectory();
  renderInspector();
  if (updateGraph) graph?.setState(state);
  if (state.view === 'document') renderReading();
  if (state.view === 'cards') renderCards();
}

function selectNode(id: string) {
  historyPanel.stop();
  if (!nodeById.has(id)) return;
  const refocusing = state.mode === 'network' && state.selected !== id;
  // 先保存真实画面，再调整滚动与布局；避免过渡启动后滚动让卡片起点跳走。
  if (refocusing) graph?.captureNavigationFrame();
  state.selected = id;
  recentNodes = [id, ...recentNodes.filter(nodeId => nodeId !== id)].slice(0,20);
  state.relationIndex = null;
  // 从详情跳到跨系统条目时解除原系统过滤，确保选中对象实际可见。
  if (state.group && nodeById.get(id)!.group !== state.group) state.group = null;
  state.query = '';
  (get('search') as HTMLInputElement).value = '';
  app.classList.remove('sidebar-open');
  get('menu-toggle').setAttribute('aria-expanded', 'false');
  sync(!refocusing);
  if (refocusing) {
    get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
    if (state.view === 'graph') revealGraphOnMobile();
    graph?.setState(state, { deferLayout: true });
    graph?.setMode('network');
  }
  get('announcement').textContent = `已选择${nodeById.get(id)!.title}`;
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
  app.classList.remove('sidebar-open');
  get('menu-toggle').setAttribute('aria-expanded', 'false');
  state.view = view;
  get('graph-view').hidden = view !== 'graph';
  get('reading-view').hidden = view !== 'document';
  get('cards-view').hidden = view !== 'cards';
  get('view-title').textContent = { graph: '知识空间', document: '策划案', cards: '卡片库' }[view];
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  graph?.setActive(view === 'graph', { deferLayout: deferGraph });
  sync(!deferGraph);
}

/** 总览只提供星图和分层两种布局；关系分析由独立入口进入。 */
function setGraphMode(mode: OverviewMode) {
  overviewMode = mode;
  state.mode = mode;
  state.relationIndex = null;
  updateSpaceNavigation();
  sync(false);
  graph?.setState(state, { deferLayout: true });
  graph?.setMode(mode);
  get('graph-view').scrollTo({ top: 0, behavior: 'instant' });
  get('announcement').textContent = `已切换到${names[mode]}`;
}

/** 两层页面共用标题区，但次级页面使用返回导航，不混入总览布局开关。 */
function updateSpaceNavigation() {
  const mode = state.mode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(item => { item.classList.toggle('active', item.dataset.mode === mode); item.setAttribute('aria-pressed', String(item.dataset.mode === mode)); });
  get('gesture').textContent = mode === 'galaxy' ? '拖动旋转 · 滚轮缩放 · 点击阅读' : mode === 'network' ? '滚动阅读 · 点击卡片更换焦点 · 点击连线看依据' : '拖动平移 · 滚轮缩放 · 点击阅读';
  get('space-intro').textContent = { galaxy: '在系统之间，发现设计的联系', network: '从规则出发，核对前提、约束与关联依据', layers: '按系统归位，从方向逐层阅读到规则' }[mode];
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
  if (button.dataset.edge !== undefined) { selectRelation(Number(button.dataset.edge)); return; }
  if (button.dataset.analyze) { enterAnalysis(button.dataset.analyze); return; }
  if (button.dataset.node) { selectNode(button.dataset.node); return; }
  if (button.dataset.locate) { selectNode(button.dataset.locate); setView('graph'); graph?.reset(); return; }
  if (button.dataset.view) { setView(button.dataset.view as View); return; }
  if (button.dataset.mode) {
    setGraphMode(button.dataset.mode as OverviewMode);
    return;
  }
  if ('group' in button.dataset) { state.group = button.dataset.group || null; state.directOnly = false; if (state.mode !== 'network') { state.selected = null; state.relationIndex = null; } (document.querySelector('.system-filter') as HTMLDetailsElement).open = false; sync(); return; }
  switch (button.id) {
    case 'project-center': case 'project-switch': void workbench.projects().catch(reportProjectError); break;
    case 'new-document': void workbench.newDocument(state.group??'').catch(reportProjectError); break;
    case 'edit-document': void workbench.edit(state.selected ? nodeById.get(state.selected)?.documentId : undefined).catch(reportProjectError); break;
    case 'item-history': if (state.selected) void historyPanel.itemHistory(state.selected, false).catch(reportProjectError); break;
    case 'document-history': if (state.selected) void historyPanel.itemHistory(nodeById.get(state.selected)!.documentId, true).catch(reportProjectError); break;
    case 'copy-node-link': if (state.selected && projectSnapshot) { const url = new URL(location.href); url.searchParams.set('project', projectSnapshot.project.id); url.hash = `cewen-doc=${encodeURIComponent(state.selected)}`; void navigator.clipboard.writeText(url.href).then(() => { get('announcement').textContent = '条目链接已复制。'; }).catch(reportProjectError); } break;
    case 'recent-reading': if (recentNodes.length) { state.scopeIds = recentNodes.filter(id => nodeById.has(id)); state.selected = null; sync(); } break;
    case 'project-history': void historyPanel.open().catch(reportProjectError); break;
    case 'organize-project': void workspacePanel.open(state.selected ?? '').catch(reportProjectError); break;
    case 'project-inquiry': void collaborationPanel.open('inquiry').catch(reportProjectError); break;
    case 'project-exchange': void collaborationPanel.open('exchange').catch(reportProjectError); break;
    case 'toggle-archived': state.includeArchived = !state.includeArchived; button.textContent = state.includeArchived ? '隐藏已归档内容' : '显示已归档内容'; sync(); break;
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
    case 'menu-toggle': app.classList.toggle('sidebar-open'); button.setAttribute('aria-expanded', String(app.classList.contains('sidebar-open'))); break;
    case 'sidebar-close': case 'sidebar-scrim': app.classList.remove('sidebar-open'); get('menu-toggle').setAttribute('aria-expanded', 'false'); break;
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
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
  if (event.key === '/' && !typing) { event.preventDefault(); if (matchMedia('(max-width:1050px)').matches) { app.classList.add('sidebar-open'); get('menu-toggle').setAttribute('aria-expanded', 'true'); } get('search').focus(); }
  if (event.key === 'Escape') {
    const menuOpen = app.classList.contains('sidebar-open');
    app.classList.remove('sidebar-open');
    get('menu-toggle').setAttribute('aria-expanded', 'false');
    if (!menuOpen && !typing && state.view === 'graph' && state.mode === 'network') leaveAnalysis();
  }
});

/** 显卡不可用时仍保留可阅读的策划和卡片，明确提示而不是留下一块空白。 */
function mountGraph(): KnowledgeGraph | undefined {
try {
  graph = new KnowledgeGraph(get('graph-canvas'), selectNode, count => {
    get('space-count').textContent = `${count} 个条目`;
    get('graph-empty').hidden = count > 0;
    get('footer-count').textContent = `${count} / ${nodes.length} 个条目 · ${edges.length} 条关系`;
  }, selectRelation, { nodes, edges, groups }, clearOverviewSelection);
  return graph;
} catch (error) {
  get('graph-canvas').innerHTML = `<div class="webgl-error"><h2>当前浏览器未能启动三维画面</h2><p>可先在策划案或卡片库阅读，也可在支持 WebGL 的浏览器重试。</p><button class="secondary-button" data-view="document">打开策划案</button></div>`;
  console.error('知识空间渲染初始化失败：', error);
  return undefined;
}
}

/** 项目变化只更新读取模型；同拓扑正文编辑不重建画布或清空分析卡片。 */
function applyProject(snapshot: ProjectSnapshot) {
  const sameProject = projectSnapshot?.project.id === snapshot.project.id;
  if (!sameProject || projectSnapshot?.revision !== snapshot.revision) readingTrail.length = 0;
  const relationId = state.relationIndex === null ? null : edges[state.relationIndex]?.id;
  projectSnapshot = snapshot;
  setKnowledgeData(snapshot);
  nodeById.clear(); nodes.forEach(node => nodeById.set(node.id, node));
  if (!sameProject) { readingReady = false; clearTimeout(readingTimer); Object.assign(state, { selected: null, relationIndex: null, group: null, query: '', directOnly: false, mode: overviewMode, scopeIds: null, includeArchived: false }); analysisOrigin = null; }
  else {
    if (state.selected && !nodeById.has(state.selected)) state.selected = null;
    if (state.group && !groups.some(group => group.id === state.group)) state.group = null;
    const index = edges.findIndex(edge => edge.id === relationId);
    state.relationIndex = index < 0 ? null : index;
  }
  get('project-name').textContent = snapshot.project.name;
  if (isWebEdition) get('edition-state').textContent = snapshot.project.path.startsWith('/app/') ? '网页版 · 浏览器示例存储' : '网页版 · 已授权本机文件夹';
  get('breadcrumb-project').textContent = snapshot.project.name;
  get('project-description').textContent = snapshot.project.isExample ? '虚构基础示例' : '独立文档 · 本地保存';
  get('refresh-project').textContent = snapshot.project.isExample ? '虚构示例 · 刷新文件' : '本地文档 · 刷新文件';
  get('system-count').textContent = String(groups.length);
  document.querySelector('.system-list')!.innerHTML = `<button data-group="" class="group-button"><span class="all-systems">${icon('circle-dot')}</span><span>全部系统</span><small>${nodes.length}</small></button>${groups.map(group => `<button class="group-button" data-group="${group.id}"><span class="group-dot" style="--group-color:${categoryColor(group.color)}"></span><span>${escape(group.label)}</span><small>${nodes.filter(node => node.group === group.id).length}</small></button>`).join('')}`;
  document.querySelector('.legend')!.innerHTML = groups.map(group => `<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('');
  get('analysis-focus').innerHTML = `<option value="">请选择条目</option>${groups.map(group => `<optgroup label="${escape(group.label)}">${nodes.filter(node => node.group === group.id).map(node => `<option value="${node.id}">${escape(node.title)}</option>`).join('')}</optgroup>`).join('')}`;
  (get('search') as HTMLInputElement).value = state.query;
  if (!sameProject || !graph) { graph?.dispose(); graph = undefined; get('graph-canvas').replaceChildren(); graph = mountGraph(); graph?.setState(state, { deferLayout: true }); graph?.setMode(state.mode); }
  else if (snapshot.historical || !graph.updateText(snapshot)) graph.updateData(snapshot);
  graph?.setActive(state.view === 'graph');
  if (nodes.length > 500) get('announcement').textContent = '大项目总览先展示系统和文档。选择系统、搜索或点击条目展开规则，也可在筛选中展开全部。';
  get('project-save-state').textContent = snapshot.recoveryRequired ? '有未完成写入 · 请查看版本' : snapshot.diagnostics.length ? `${snapshot.diagnostics.length} 项待核对` : '文档与版本已同步';
  connectionError = '';
  updateSpaceNavigation(); sync(); refreshIcons();
  historyPanel.sync(snapshot);
  if (!sameProject) { readingReady = false; void restoreReading().catch(reportProjectError); }
  (get('edit-document') as HTMLButtonElement).disabled = Boolean(snapshot.historical);
  (get('new-document') as HTMLButtonElement).disabled = Boolean(snapshot.historical);
  if (snapshot.historical) get('project-save-state').textContent = `${snapshot.revisionLabel} · 历史只读`;
}

/** 外部变化到来时只替换已读投影，正在编辑的原稿基准由工作面板独立保留。 */
async function refreshProject(verify = false) {
  if (!projectSnapshot) { await workbench.projects(); return; }
  if (projectSnapshot.historical) return;
  const id = projectSnapshot.project.id, snapshot = await readProject(id, verify);
  if (projectSnapshot?.project.id !== id) return;
  if (snapshot.fingerprint !== projectSnapshot.fingerprint || snapshot.revision !== projectSnapshot.revision || snapshot.recoveryRequired !== projectSnapshot.recoveryRequired || JSON.stringify(snapshot.diagnostics) !== JSON.stringify(projectSnapshot.diagnostics)) applyProject(snapshot);
  else get('project-save-state').textContent = snapshot.recoveryRequired ? '有未完成写入 · 请查看版本' : snapshot.diagnostics.length ? `${snapshot.diagnostics.length} 项待核对` : '文档与版本已同步';
}
function reportProjectError(error: unknown) { connectionError = error instanceof Error ? error.message : '本地项目操作未完成。'; get('project-save-state').textContent = connectionError; get('announcement').textContent = connectionError; renderInspector(); }

const workbench = new ProjectWorkbench(() => projectSnapshot, applyProject);
/** 上下文菜单在当前画布旁出现；所有操作回到同一编辑与保存流程。 */
const graphMenu=document.createElement('div');graphMenu.className='star-context-menu';graphMenu.hidden=true;graphMenu.setAttribute('aria-label','星图快捷操作');document.body.append(graphMenu);
const closeGraphMenu=()=>{graphMenu.hidden=true;graph?.setContextMenuOpen(false);};
function openGraphMenu(detail:{id?:string;x:number;y:number}){
  if(!projectSnapshot)return;const node=detail.id?nodeById.get(detail.id):undefined;
  const actions=projectSnapshot.historical?[['latest','回到最新版本']]:node?.kind==='system'?[['dd','在此分类新建 DD'],['category','修改分类'],['question','记录设计问题']]:node?[['edit','打开写作'],['dd','新建专项设计'],['category-document','更改文档分类'],['annotation','批注与标记'],['prompt','让 LLM 深挖']]:[['dd','新建专项设计 DD'],['gdd','编写游戏总纲'],['question','记录设计问题'],['category','新建设计分类'],['prompt','与 LLM 一起构思']];
  graphMenu.innerHTML=`<small>${escape(node?.title??'在星图中开始')}</small>${actions.map(([action,label])=>`<button data-star-action="${action}">${label}</button>`).join('')}`;graphMenu.hidden=false;
  graphMenu.style.left=`${Math.max(8,Math.min(detail.x,innerWidth-graphMenu.offsetWidth-8))}px`;graphMenu.style.top=`${Math.max(8,Math.min(detail.y,innerHeight-graphMenu.offsetHeight-8))}px`;graph?.setContextMenuOpen(true);
  graphMenu.onclick=event=>{const action=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-star-action]')?.dataset.starAction;if(!action)return;closeGraphMenu();void(async()=>{switch(action){case 'dd':await workbench.newDocument(node?.group??state.group??'');break;case 'gdd':await workbench.newDocument('','gdd');break;case 'question':await workbench.newDocument(node?.group??'','question');break;case 'category':await workbench.categories(node?.kind==='system'?node.id:'');break;case 'category-document':case 'edit':await workbench.edit(node?.documentId);break;case 'annotation':await workspacePanel.open(node?.id??'');break;case 'prompt':await openCollaboration(node?'inquiry':'start',projectSnapshot,node?.documentId?[node.documentId]:[]);break;case 'latest':applyProject(await readProject(projectSnapshot!.project.id));break;}})().catch(reportProjectError);};
  graphMenu.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
}
window.addEventListener('cewen:graph-context',event=>openGraphMenu((event as CustomEvent).detail));
document.addEventListener('pointerdown',event=>{if(!graphMenu.contains(event.target as Node))closeGraphMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeGraphMenu();});
window.addEventListener('resize',closeGraphMenu);
const graphCreate=document.createElement('button');graphCreate.className='secondary-button graph-create-button';graphCreate.textContent='＋ 新建';get('graph-canvas').parentElement!.append(graphCreate);graphCreate.addEventListener('click',()=>{const box=graphCreate.getBoundingClientRect();openGraphMenu({x:box.left,y:box.top-190});});
const collaborationButton=document.createElement('button');collaborationButton.className='secondary-button';collaborationButton.textContent='与 LLM 协作';document.querySelector('.project-toolbar')!.append(collaborationButton);collaborationButton.addEventListener('click',()=>void openCollaboration(state.selected?'inquiry':'start',projectSnapshot,state.selected?[nodeById.get(state.selected)!.documentId].filter(Boolean):[]));
window.addEventListener('cewen-theme-change',()=>{renderDirectory();renderInspector();renderCards();document.querySelectorAll<HTMLElement>('.system-list [data-group]').forEach(button=>{const group=groups.find(group=>group.id===button.dataset.group),dot=button.querySelector<HTMLElement>('.group-dot');if(group&&dot)dot.style.setProperty('--group-color',categoryColor(group.color));});document.querySelector('.legend')!.innerHTML=groups.map(group=>`<span><i style="background:${categoryColor(group.color)}"></i>${escape(group.label)}</span>`).join('');});
const historyPanel = new HistoryPanel(() => projectSnapshot, applyProject);
const workspacePanel = new WorkspacePanel(() => projectSnapshot, selectNode, item => workbench.publishAnnotation(item), (ids, title) => { state.scopeIds = ids; state.selected = null; state.relationIndex = null; sync(); get('announcement').textContent = `正在查看工作分组：${title}。清除筛选可返回全部。`; }, () => ({ ...state }), restoreReadingState, applyProject);
/** 阅读状态与稳定坐标从工作区恢复，不介入公开文档历史。 */
function restoreReadingState(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const saved = value as Partial<typeof state>;
  state.query = typeof saved.query === 'string' ? saved.query : ''; state.group = groups.some(group => group.id === saved.group) ? saved.group! : null; state.scopeIds = Array.isArray(saved.scopeIds) ? saved.scopeIds.filter(id => nodeById.has(id)) : null; state.includeArchived = saved.includeArchived === true; state.detailedGraph = saved.detailedGraph === true;
  state.selected = saved.selected && nodeById.has(saved.selected) ? saved.selected : null;
  state.directOnly = saved.directOnly === true; state.labelsAll = saved.labelsAll === true; state.paused = saved.paused === true;
  get('toggle-labels').setAttribute('aria-pressed', String(state.labelsAll));
  get('toggle-motion').setAttribute('aria-pressed', String(state.paused));
  if (saved.view && ['graph','document','cards'].includes(saved.view)) setView(saved.view);
  if (saved.mode === 'galaxy' || saved.mode === 'layers') setGraphMode(saved.mode);
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
const collaborationPanel = new CollaborationPanel(() => projectSnapshot, applyProject);
graph = mountGraph();
sync();
void restoreReading().catch(reportProjectError);
refreshIcons();
if (!projectSnapshot) void workbench.projects().catch(reportProjectError);
/** 聚焦和定期扫描补足外部保存；后续监听仍需沿用相同哈希核对。 */
let refreshing = false;
const scan = () => { if (refreshing || !projectSnapshot || document.hidden) return; refreshing = true; void refreshProject().catch(reportProjectError).finally(() => { refreshing = false; }); };
window.addEventListener('focus', scan);
setInterval(scan, 4000);
// 浏览器把页面暂存到前进后退缓存时保留场景；真正卸载时才释放显卡资源。
window.addEventListener('pagehide', event => {
  if (event.persisted) graph?.setActive(false);
  else { graph?.dispose(); connectionPanel.dispose(); }
});
window.addEventListener('pageshow', event => { if (event.persisted) graph?.setActive(state.view === 'graph'); });
