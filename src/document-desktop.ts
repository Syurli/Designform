import { pickDocumentPreset } from './document-preset-picker';
import type { ProjectSnapshot,ProjectDocument,FileChange,KnowledgeGroup,DocumentDraft } from '../shared/model';
import { readHeader,parseKnowledge } from '../shared/markdown';
import { setMetadata,setTitle } from '../shared/editing';
import { layoutCompanionPath,type LayoutCompanion } from '../shared/document-companion';
import { builtinDocumentPresets,instantiateDocumentPreset,captureDocumentPreset,documentPresetTags,type DocumentPreset } from '../shared/document-presets';
import { buildCreativeIndex,objectBlock } from '../shared/creative/content';
import { moduleRegistry } from '../shared/creative/registry';
import { isTransientProject,transientProjects,draftMediaUrls } from '../shared/transient';
import { APP_VERSION } from '../shared/version';
import { ProjectDirectory } from './project-directory';
import { groupAncestors } from '../shared/project-hierarchy';
import { documentSortLabels, sortDocuments, type DocumentSort } from '../shared/document-order';
import { documentPinScope, readDocumentListState, saveDocumentListState, loadCollectionFavorites } from './document-list-state';
import { DocumentCanvas, type CanvasPoint } from './document-canvas';
import { DocumentToolbox } from './document-toolbox';
import { parseDocumentBlocks } from '../shared/document-blocks';
import { sizedImageMarkup, parseSizedImage } from '../shared/image-markup';
import { textStyleOpenTag } from '../shared/text-style';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mountDocumentPresentation, locatePresentationSection } from './document-presentation';
import { RoundQuestions, forgetRoundSession } from './round-questions';
import { inquiry } from '../shared/inquiry';
import { projectMarkdown } from './document-reading';
import { mountCreativeBlocks } from './creative/inline';
import { openObjectEditor } from './creative/editor';
import { detectMedia } from '../shared/creative/media';
import { mediaInput } from './creative/production-panel';
import { CreativeWorkspace } from './creative/workspace';
import { cloneCreativeObject } from '../shared/creative/clone';
import { AnimaticPlayer } from './creative/player';
import { h } from './creative/render';
import { request,listProjects,cacheDraft,saveDraft,deleteDraft,projectDrafts,projectAction,uploadProjectMedia,projectAssetUrl } from './project-client';
import { ProjectLibraryView } from './project-library';
import { beginProjectLoading, currentProjectLoading, type ProjectLoadingTask } from './project-loading';
import { projectWizard } from './project-wizard';
import { appForm,appChoice } from './app-dialog';
import { pickLearningExample } from './examples/example-picker';
import { showAppMenu,type AppCommand } from './app-menu';
import { openCollaboration } from './prompt-panel';
import { DOCUMENT_DRAG_TYPE, readDocumentDrag, type DocumentDrag } from './document-drag';
import { resolveDocumentLink } from './markdown-view';
import './document-desktop.css';
import { projectWorkView } from '../shared/collaboration';
import { categoryColor } from './category-color';
import { desktopCommand,applyTheme,currentTheme } from './theme';
import { createElement, Lock, LockOpen } from 'lucide';
import { openInputSettings, shortcutAction, shortcutLabel } from './input-settings';
import { browse,canBrowse,historyScope,recordVisit } from './browse-history';
import { aboutDesignform } from './about';

/** 每份文档的编辑实例、撤销链和保存基准相互独立；切换标签不会卸载编辑器。 */
interface DocumentTab {
  doc:ProjectDocument; baseText:string|null; baseHash:string|null; layout:LayoutCompanion; baseLayoutHash:string|null;
  mode:'preview'|'edit'|'questions';locked:boolean;reordering:boolean;preview:HTMLElement;previewKey?:string;disposePreview?:()=>void;questionHost:HTMLElement;questions?:RoundQuestions;dirty:boolean;pinned:boolean;host:HTMLElement;canvas:DocumentCanvas;disposeMedia?:()=>void;assets:FileChange[];preset?:DocumentPreset;
}
/** 文档视图用阅读身份定位，自由视图用真实画布坐标定位插入。 */
interface InsertionTarget { point?:CanvasPoint; afterId?:string; client?:{x:number;y:number} }
export interface DesktopOptions {apply(snapshot:ProjectSnapshot):void;document():void;graph(mode?:'galaxy'|'layers'|'mindmap',documentId?:string):void;history():void;connections():void;proposals():void;legacyAction(detail:{action:string;objectId?:string}):void;captureReading?():()=>void;includeArchived?():boolean}

/** 桌面主工作区：项目库 → 项目文档树 → 标签页中的自由画布。 */
export class DocumentDesktop {
  readonly root=document.createElement('section');
  private libraryHost=document.createElement('section');private work=document.createElement('section');private library:ProjectLibraryView;
  private snapshot?:ProjectSnapshot;private tabs=new Map<string,DocumentTab>();private active='';private selected=new Set<string>();private lastSelected='';
  private directory?:ProjectDirectory;
  /** 目录只随正文、身份、分类或时间投影变化重解析；切换标签和展开目录复用相同知识结构。 */
  private directoryProjection?:{source:ProjectSnapshot;key:string;value:ProjectSnapshot};
  private toolbarHost!:HTMLElement;private modeHost!:HTMLElement;private questionNav=document.createElement('div');
  /** 策问属于整个项目，阅读标签、目录筛选和画布始终保留自己的实例。 */
  private projectQuestions?:RoundQuestions;private projectQuestionHost=document.createElement('section');private questionsActive=false;
  private questionStats?:{pending:number;drafts:number};
  private questionReadingReturn?:()=>void;
  private questionReadingFrame?:{active:string;overview:boolean;category?:string};
  private menu!:HTMLElement;private tree!:HTMLElement;private tabbar!:HTMLElement;private canvases!:HTMLElement;private inspector!:HTMLElement;private footer!:HTMLElement;
  private structure?:{text:string;baseHash:string};private busy=false;private home=true;
  /** 跨帧载入期间只允许一个打开流程，重复消息不会同时替换项目和标签。 */
  private openingProject=false;
  private contextDispose?:()=>void;private sessionChanged=false;
  private inlineDispose?:()=>void;private users:DocumentPreset[]=[];
  /** 总览翻页属于个人阅读状态，不改变项目、文档或排序数据。 */
  private overviewPage=0;private overviewScope='';
  private overviewObserver?:ResizeObserver;
  /** 总览重新绘制仍保留滚轮手势状态，触控板的惯性尾段不会连续翻过多页。 */
  private overviewWheel={amount:0,direction:0,last:0,latched:false};
  /** 文档与图谱读取同一归档偏好，恢复阅读状态时也不会出现按钮与列表相反。 */
  private get includeArchived(){return this.options.includeArchived?.()??false;}
  private tools=new DocumentToolbox(()=>this.current()?.canvas,()=>this.isDocumentLocked(),message=>this.notice(message));
  /** 移动归属属于项目结构草稿，放弃某页正文不会撤销它。 */
  /** 草稿先存本机应急副本，再合并短时间连续输入写入项目私有草稿。 */
  private draftWrites=new Map<string,{projectId:string;draft:DocumentDraft;timer?:ReturnType<typeof setTimeout>;pending?:Promise<void>}>();
  private removed=new Map<string,ProjectDocument>();
  private moves=new Map<string,{system:string;parent?:string}>();
  constructor(private options:DesktopOptions){
    this.root.className='document-desktop';this.libraryHost.className='desktop-library';this.work.className='desktop-work';this.work.hidden=true;
    this.root.append(this.libraryHost,this.work);document.body.append(this.root);
    this.library=new ProjectLibraryView(this.libraryHost,(snapshot,loading)=>this.open(snapshot,false,loading),()=>this.newProject(),()=>this.examples(),()=>this.snapshot?{name:this.snapshot.project.name,dirty:this.hasChanges(),resume:()=>this.returnToProject()}:undefined,async id=>id!==this.snapshot?.project.id||await this.leave(),id=>{if(id===this.snapshot?.project.id){this.clear();this.snapshot=undefined;this.updateTitle();}});
    this.buildShell();this.updateHistoryButtons();
    window.addEventListener('cewen:archive-filter',event=>{this.renderTree();const overview=this.canvases.querySelector<HTMLElement>('.document-overview');if(overview)this.cards(overview.dataset.cardCategory);});
    window.addEventListener('cewen:browse-history-change',()=>this.updateHistoryButtons());
    window.addEventListener('cewen-theme-change',()=>{if(this.snapshot)this.renderTree();});
    window.addEventListener('cewen:document-list-change',event=>{
      const overview=this.canvases.querySelector<HTMLElement>('.document-overview');
      if(overview&&(event as CustomEvent<{projectId:string}>).detail.projectId===this.snapshot?.project.id)this.cards(overview.dataset.cardCategory);
    });
    window.addEventListener('keydown',e=>{if(this.visible&&!e.defaultPrevented&&!((e.target as HTMLElement).closest('.app-command-menu')))this.key(e);});
    window.addEventListener('cewen:operation-error',e=>this.report((e as CustomEvent).detail));
    window.addEventListener('cewen:editing-command',e=>{if(this.root.hidden||this.home)return;const cmd=(e as CustomEvent<string>).detail;if(['copy','cut','paste','selectAll'].includes(cmd)&&!(document.activeElement as HTMLElement)?.closest('input,textarea,[contenteditable=true]')){e.preventDefault();void this.current()?.canvas.clipboard(cmd as 'copy'|'cut'|'paste'|'selectAll').catch(error=>this.report(error));return;}if(!['save','undo','redo'].includes(cmd))return;if(this.questionsActive){if(cmd==='save'){e.preventDefault();this.projectQuestions?.captureDraft();this.notice('策问草稿已保留，正式提交请使用本轮汇总。');}return;}if(cmd!=='save'&&(document.activeElement as HTMLElement)?.closest('input,textarea,[contenteditable=true]')&&!(document.activeElement as HTMLElement)?.closest('.canvas-inline-editor,.rich-text-style-panel'))return;e.preventDefault();if(cmd==='save')void this.save().catch(err=>this.report(err));if(cmd==='undo'&&!this.isDocumentLocked())this.current()?.canvas.undo();if(cmd==='redo'&&!this.isDocumentLocked())this.current()?.canvas.redo();},{capture:true});
    window.addEventListener('beforeunload',e=>{this.projectQuestions?.captureDraft();if(this.hasChanges()){e.preventDefault();e.returnValue='';}});
    void this.library.refresh().catch(e=>this.report(e));
  }
  /** 本机服务接管前包含正文、结构、个人策问草稿与当前输入状态。 */
  get hasUnsavedChanges(){return this.hasChanges()||!!this.questionStats?.drafts||[...this.tabs.values()].some(tab=>tab.canvas.isEditing);}
  get isHome(){return this.home;}
  get visible(){return !this.root.hidden;}
  /** 主壳保存进入策问前的视图，文档标签的阅读位置由本工作区独立保留。 */
  setReadingReturnFactory(factory:()=>()=>void){this.options.captureReading=factory;}
  private current(){return this.tabs.get(this.active);}
  /** 锁按项目与文档保存为个人偏好；历史快照始终只读，任何视图都不能解锁。 */
  isDocumentLocked(id=this.active){if(this.snapshot?.historical||this.snapshot?.collaboration?.locks[id])return true;const tab=this.tabs.get(id);if(tab)return tab.locked;try{return localStorage.getItem(this.lockKey(id))==='locked';}catch{return false;}}
  private lockKey(id:string){return `cewen:document-lock:${this.snapshot?.project.id??''}:${id}`;}
  /** 个人阅读锁独立于服务端工作锁，任务结束不能改变个人偏好。 */
  private personalDocumentLock(id:string){try{return localStorage.getItem(this.lockKey(id))==='locked';}catch{return false;}}
  private allowWrite(id=this.active){if(!this.isDocumentLocked(id))return true;this.notice(this.snapshot?.historical?'历史版本只读。':this.snapshot?.collaboration?.locks[id]?'LLM 正在编写此文档，请在连接面板停止任务。':'文档已锁定，请先点击右上角的锁解锁。');return false;}
  private toggleDocumentLock(tab:DocumentTab){
    if(this.snapshot?.historical||this.snapshot?.collaboration?.locks[tab.doc.id])return;tab.canvas.finishEditing();this.inlineDispose?.();this.inlineDispose=undefined;tab.locked=!tab.locked;tab.reordering=false;
    try{if(tab.locked)localStorage.setItem(this.lockKey(tab.doc.id),'locked');else localStorage.removeItem(this.lockKey(tab.doc.id));}catch{/* 浏览器未允许持久存储时，当前标签的锁仍然有效。 */}
    tab.canvas.setReadOnly(tab.locked);tab.previewKey=undefined;this.renderTabs();this.renderProperties();this.notice(tab.locked?'文档已锁定，可继续阅读与切换视图。':'文档已解锁，两种视图均可直接编辑。');
    window.dispatchEvent(new CustomEvent('cewen:document-lock-change',{detail:{documentId:tab.doc.id,locked:tab.locked}}));
  }
  private hasChanges(){return this.sessionChanged||!!this.removed.size||!!this.structure||!!this.moves.size||[...this.tabs.values()].some(t=>t.dirty);}
  private report(error:unknown){const message=error instanceof Error?error.message:String(error);this.footer.textContent=message;this.footer.setAttribute('data-error','');if(this.home){let box=this.libraryHost.querySelector<HTMLElement>('[role=status]');if(!box){box=document.createElement('p');box.setAttribute('role','status');this.libraryHost.append(box);}box.textContent=message;}}
  private notice(text:string){this.footer.textContent=text;this.footer.removeAttribute('data-error');}
  private buildShell(){
    this.work.innerHTML=`<header class="document-menu"><button data-browse="back" aria-label="浏览上一页" title="浏览上一页">←</button><button data-browse="forward" aria-label="浏览下一页" title="浏览下一页">→</button><button data-home>项目库</button><button data-file>文件</button><button data-edit>编辑</button><button data-view>视图</button><button data-presets>文档预设</button><button data-help>帮助</button><strong data-project-title></strong><span data-session-kind></span></header><div class="document-work-grid"><aside class="document-tree-panel"><header><strong>项目文档</strong><button data-new title="新建文档">＋</button><button data-tree-menu aria-label="文档树选项">⋯</button></header><div class="document-tree" aria-label="项目文档目录"></div></aside><main class="document-center"><div class="document-tab-strip"><div class="document-tabs" role="tablist"></div><div class="document-mode-tools"></div><div class="document-tools" aria-label="当前画布工具"></div></div><div class="document-canvases"></div></main><aside class="document-properties" aria-label="文档属性"></aside></div><footer class="document-status" role="status" aria-live="polite"></footer>`;
    this.modeHost=this.work.querySelector('.document-mode-tools')!;this.menu=this.work.querySelector('.document-menu')!;this.toolbarHost=this.work.querySelector('.document-tools')!;
    this.tree=this.work.querySelector('.document-tree')!;this.tabbar=this.work.querySelector('.document-tabs')!;this.canvases=this.work.querySelector('.document-canvases')!;this.inspector=this.work.querySelector('.document-properties')!;this.footer=this.work.querySelector('.document-status')!;
    const splitter=document.createElement('div');splitter.className='document-sidebar-splitter';splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-label','调整文档侧栏宽度');splitter.setAttribute('aria-orientation','vertical');this.work.querySelector('.document-tree-panel')!.append(splitter);
    splitter.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();const start=e.clientX,width=this.tree.parentElement!.getBoundingClientRect().width;splitter.setPointerCapture(e.pointerId);const move=(next:PointerEvent)=>this.work.style.setProperty('--tree-width',Math.min(440,Math.max(190,width+next.clientX-start))+'px');const end=()=>{splitter.removeEventListener('pointermove',move);splitter.removeEventListener('pointerup',end);splitter.removeEventListener('pointercancel',end);};splitter.addEventListener('pointermove',move);splitter.addEventListener('pointerup',end);splitter.addEventListener('pointercancel',end);};
    splitter.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();this.work.style.setProperty('--tree-width',Math.min(440,Math.max(190,this.tree.parentElement!.clientWidth+(e.key==='ArrowLeft'?-16:16)))+'px');}};
    const commandClick=(e:MouseEvent)=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b)return;const run=(p:Promise<unknown>)=>void p.catch(err=>this.report(err));
      if(b.dataset.browse)browse(b.dataset.browse as 'back'|'forward');if(b.hasAttribute('data-settings'))run(openInputSettings());
      if(b.hasAttribute('data-home'))run(this.showLibrary());if(b.hasAttribute('data-new'))run(this.newDocument());if(b.hasAttribute('data-presets'))run(this.presetLibrary());
      if(b.hasAttribute('data-file'))showAppMenu(this.fileCommands(),b);if(b.hasAttribute('data-edit'))showAppMenu([{label:'撤销',shortcut:shortcutLabel('undo'),disabled:this.isDocumentLocked(),run:()=>desktopCommand('undo')},{label:'重做',shortcut:shortcutLabel('redo'),disabled:this.isDocumentLocked(),run:()=>desktopCommand('redo')},...(window.cewenDesktop?[{label:'剪切',disabled:this.isDocumentLocked(),run:()=>desktopCommand('cut')},{label:'复制',run:()=>desktopCommand('copy')},{label:'粘贴',disabled:this.isDocumentLocked(),run:()=>desktopCommand('paste')},{label:'全选',run:()=>desktopCommand('selectAll')}]:[]),{label:'重命名文档…',shortcut:shortcutLabel('rename'),disabled:this.home||this.isDocumentLocked(),run:()=>this.rename()}],b);
      if(b.hasAttribute('data-view'))showAppMenu([
        {label:'文档画布',disabled:!this.snapshot,run:()=>this.show()},
        {label:'星空视图',disabled:!this.snapshot,run:()=>this.graphView('galaxy')},
        {label:'分类分层视图',disabled:!this.snapshot,run:()=>this.graphView('layers')},
        {label:'思维导图视图',disabled:!this.snapshot,run:()=>this.graphView('mindmap')},
        {label:'当前文档的卡片关系预览',disabled:!this.current()||!!this.current()?.preset,run:()=>this.graphView(undefined,this.active)},
        {label:'文档卡片视图',disabled:!this.snapshot,run:()=>{this.show();this.cards();}},
        {label:'属性侧栏',disabled:this.home,run:()=>{if(innerWidth<1000){this.work.classList.remove('hide-properties');this.work.classList.toggle('show-properties');}else this.work.classList.toggle('hide-properties');}},
        {label:'文档大纲',disabled:this.home,run:()=>this.outline()},{label:'适应画布',disabled:this.home,run:()=>this.current()?.canvas.fit()},
        {label:'保存当前阅读视图',disabled:!this.snapshot,run:()=>window.dispatchEvent(new CustomEvent('cewen:save-reading-view'))},
        {label:'版本历史',disabled:!this.snapshot,run:()=>this.options.history()},{label:'连接与集成',run:()=>this.options.connections()},
        {label:currentTheme()==='dark'?'切换浅色主题':'切换深色主题',separator:true,run:()=>applyTheme(currentTheme()==='dark'?'light':'dark')},
        ...(window.cewenDesktop?[{label:'放大界面',run:()=>desktopCommand('zoomIn')},{label:'缩小界面',run:()=>desktopCommand('zoomOut')},{label:'恢复界面比例',run:()=>desktopCommand('resetZoom')}]:[])
      ],b);
      if(b.hasAttribute('data-help'))showAppMenu([{label:'示例与新手教程',run:()=>this.examples()},{label:'快捷键与鼠标设置…',shortcut:shortcutLabel('settings'),run:()=>openInputSettings()},{label:'关于策问',run:()=>this.about()}],b);
      if(b.hasAttribute('data-tree-menu'))showAppMenu([{label:'新建基础文档',run:()=>this.newDocument()},{label:'新建分类…',run:()=>this.newCategory()},{label:'新建收藏分类…',run:()=>this.directory?.addFavoriteCategory([...this.selected])},{label:'定位当前文档',run:()=>this.reveal(this.active)}],b);
    };
    this.work.addEventListener('click',commandClick);
    // 菜单合并到壳栏，浏览器版放入原应用栏；整个软件保留原主面板骨架。
    const chrome=document.querySelector('.desktop-titlebar-content')??document.querySelector('.application-bar');
    if(chrome){chrome.prepend(this.menu);this.menu.addEventListener('click',commandClick);}
    this.questionNav.className='document-question-nav';this.questionNav.hidden=true;this.tree.parentElement!.append(this.questionNav);
    this.projectQuestionHost.className='desktop-round-questions project-round-questions';this.projectQuestionHost.hidden=true;
    const treePanel=this.tree.parentElement!;document.querySelector('#project-sidebar')!.append(treePanel);treePanel.addEventListener('click',commandClick);
  }
  /** 图谱使用原场景、镜头过渡与关系卡片，保存前不会把新文档伪装成正式关系。 */
  private graphView(mode?:'galaxy'|'layers'|'mindmap',documentId?:string){
    if(!this.snapshot)return;if(documentId&&!this.snapshot.documents.some(d=>d.id===documentId)){this.notice('请先保存新文档，再查看关系。');return;}this.exitQuestions(false);
    this.root.hidden=true;this.options.graph(mode,documentId);
  }
  private fileCommands():AppCommand[]{return [
    {label:'快捷键与鼠标设置…',shortcut:shortcutLabel('settings'),run:()=>openInputSettings()},
    {label:'新建项目…',shortcut:shortcutLabel('newProject'),run:()=>this.newProject()},
    {label:'新建基础文档…',shortcut:shortcutLabel('newDocument'),disabled:!this.snapshot,run:()=>this.newDocument()},
    {label:'保存当前文档',shortcut:shortcutLabel('save'),disabled:!this.current(),run:()=>this.save()},
    {label:'保存全部文档与结构',shortcut:shortcutLabel('saveAll'),run:()=>this.save(true)},
    {label:'项目另存为…',shortcut:shortcutLabel('saveAs'),run:()=>this.saveAs()},
    {label:'保存当前文档为预设…',run:()=>this.capturePreset()},
    {label:'关闭当前标签',shortcut:shortcutLabel('close'),run:()=>this.closeTab(this.active)},
    {label:'返回项目库',separator:true,run:()=>this.showLibrary()},
    {label:'关闭当前项目',disabled:!this.snapshot,run:()=>this.closeProject()},
    ...(window.cewenDesktop?[{label:'在浏览器打开',run:()=>desktopCommand('browser')},{label:'收起到系统托盘',run:()=>desktopCommand('hide')},{label:'退出策问',run:()=>desktopCommand('quit')}]:[]),
  ];}
  show(){
    this.root.hidden=false;const app=document.getElementById('app')!;
    if(this.home){document.body.append(this.root);this.root.classList.remove('embedded-document-desktop');app.classList.remove('document-canvas-open');app.hidden=true;}
    else{app.hidden=false;document.querySelector('.work-area')!.append(this.root);this.root.classList.add('embedded-document-desktop');this.options.document();}
  }
  /** 项目库、链接启动和直接示例打开共用同一载入任务，阶段之间先绘制再处理真实数据。 */
  async open(snapshot:ProjectSnapshot,admitted=false,providedLoading?:ProjectLoadingTask){
    if(this.openingProject)return;this.openingProject=true;
    let loading=providedLoading??currentProjectLoading();
    const sameProject=this.snapshot?.project.id===snapshot.project.id&&!admitted;
    try{
      loading?.throwIfCancelled();
      if(!sameProject&&!admitted&&this.snapshot?.project.id!==snapshot.project.id&&!await this.leave())return;
      // 已收到快照的直接入口不重新读取文件；现有任务则沿用其已完成的读取阶段。
      const existingLoading=loading;loading??=beginProjectLoading(snapshot.project.name,{cancellable:false});if(!loading)return;
      loading.throwIfCancelled();loading.setTitle(snapshot.project.name);loading.setCancellable(false);
      if(!existingLoading){loading.stage('files','项目文件已读取，正在转入工作台');await loading.paint();}
      loading.stage('categories',`${snapshot.groups.length} 个分类 · ${snapshot.documents.length} 份文档`);await loading.paint();
      if(sameProject){
        // 当前项目保留所有标签和草稿，只刷新目录与干净内容，随后恢复工作台。
        this.renderTree();
        loading.stage('content','更新当前项目内容');await loading.paint();this.receive(snapshot);
        loading.stage('interface','恢复当前工作台');await loading.paint();this.returnToProject();await loading.paint();return;
      }
      const previous=this.snapshot?.project.id;this.clear();
      if(previous&&previous!==snapshot.project.id&&isTransientProject(previous)){forgetRoundSession(previous);(await import('../browser/transient-projects')).disposeTransient(previous);}
      this.snapshot=snapshot;
      // 收藏迁入属于个人偏好，接口暂不可用时仍正常打开正文，并留下明确提示。
      await loadCollectionFavorites(snapshot).catch(error=>this.report(error));
      this.home=false;this.libraryHost.hidden=true;this.work.hidden=false;
      this.renderTree();this.updateTitle();
      loading.stage('content','准备项目内容与首份文档');await loading.paint();
      this.show();this.options.apply(snapshot);
      const first=this.documents().find(doc=>doc.path.endsWith('/start.md'))??this.documents()[0];
      if(first)this.openDocument(first.id);else this.renderTabs();
      loading.stage('interface','显示文档与项目工具');await loading.paint();
      this.show();this.notice(isTransientProject(snapshot.project.id)?'临时示例 · 所有编辑仅存于本次会话；保存将另存为新项目。':'单击打开，双击固定标签；空白左键拖动画布，右键拖动框选。');
      await this.recoverDrafts();await loading.paint();
    }catch(error){if(loading?.signal.aborted)return;throw error;}
    finally{loading?.finish();this.openingProject=false;}
  }
  /** 外部刷新只更新干净标签；有草稿的标签保留旧哈希供正式保存时判断冲突。 */
  receive(snapshot:ProjectSnapshot){if(this.snapshot?.project.id!==snapshot.project.id||snapshot.historical)return;if(isTransientProject(snapshot.project.id)&&snapshot.revision!==this.snapshot.revision)this.sessionChanged=true;for(const t of this.tabs.values())if(snapshot.collaboration?.locks[t.doc.id]){t.canvas.finishEditing();if(t.dirty)this.changed(t);}this.snapshot=snapshot;for(const [id,t] of this.tabs){const doc=snapshot.documents.find(d=>d.id===id);if(!doc&&!t.dirty&&!t.preset&&!snapshot.collaboration?.documents.some(d=>d.id===id)){this.disposeTab(t);this.tabs.delete(id);continue;}if(doc&&!t.dirty&&!t.canvas.isEditing&&!t.preset&&doc.hash!==t.baseHash){this.disposeTab(t);this.tabs.delete(id);const next=this.mountTab(doc,t.pinned);next.mode=t.mode;}}for(const t of this.tabs.values()){t.canvas.setReadOnly(this.isDocumentLocked(t.doc.id));t.previewKey=undefined;t.questions?.receive(snapshot);}this.projectQuestions?.receive(snapshot);this.renderTree();this.renderTabs();this.updateTitle();this.updateQuestionBrand();}
  private clear(){for(const [key,entry] of this.draftWrites)if(entry.timer)void this.flushPersonalDraft(key);this.projectQuestions?.dispose();this.projectQuestions=undefined;this.questionsActive=false;this.questionStats=undefined;this.questionReadingReturn=undefined;this.questionReadingFrame=undefined;this.projectQuestionHost.hidden=true;this.tree.hidden=false;this.questionNav.hidden=true;this.questionNav.replaceChildren();this.work.classList.remove('project-question-mode');this.overviewObserver?.disconnect();this.overviewObserver=undefined;if(this.snapshot)for(const [key,url] of draftMediaUrls)if(key.startsWith(this.snapshot.project.id+':')){URL.revokeObjectURL(url);draftMediaUrls.delete(key);}this.contextDispose?.();this.contextDispose=undefined;this.sessionChanged=false;this.inlineDispose?.();for(const t of this.tabs.values())this.disposeTab(t);this.tabs.clear();this.removed.clear();this.moves.clear();this.canvases.replaceChildren();this.active='';this.selected.clear();this.structure=undefined;}
  private disposeTab(t:DocumentTab){t.disposePreview?.();t.questions?.dispose();t.disposeMedia?.();t.canvas.dispose();t.host.remove();}
  private updateTitle(){this.menu.querySelector('[data-project-title]')!.textContent=this.snapshot?.project.name??'';this.menu.querySelector('[data-session-kind]')!.textContent=this.snapshot&&isTransientProject(this.snapshot.project.id)?'临时会话 · 关闭不保存':'';this.updateQuestionBrand();}
  private documents(){const docs=new Map((this.snapshot?projectWorkView(this.snapshot).documents:[]).filter(d=>!['docs/README.md','docs/INDEX.md'].includes(d.path)&&!this.removed.has(d.id)&&!d.path.startsWith('docs/media/')&&!d.id.startsWith('unidentified:')).map(d=>[d.id,d]));for(const [id,t] of this.tabs)if(!t.preset&&!this.snapshot?.collaboration?.documents.some(d=>d.id===id))docs.set(id,t.doc);return [...docs.values()].map(d=>{const move=this.moves.get(d.id);return move?{...d,...move,text:setMetadata(d.text,{system:move.system||undefined,parent:move.parent})}:d;});}
  private projected(){const snapshot=structuredClone(this.snapshot!);snapshot.documents=this.current()?.preset?[this.current()!.doc]:[...new Map([...snapshot.documents.filter(d=>!this.removed.has(d.id)),...this.documents()].map(d=>[d.id,d])).values()];if(this.structure)snapshot.projectEntry={text:this.structure.text,hash:this.structure.baseHash};return snapshot;}
  private groups():KnowledgeGroup[]{return this.structure?parseKnowledge([{path:'PROJECT.md',text:this.structure.text,hash:this.structure.baseHash}]).groups:this.snapshot?.groups??[];}
  openDocument(id:string,pinned=false){
    // 目录章节使用“文档身份/锚点”；打开所属标签后继续定位，不丢弃章节身份。
    const slash=id.indexOf('/'),anchor=slash>=0?id.slice(slash+1):'';
    if(slash>=0)id=id.slice(0,slash);
    if(this.questionsActive)this.exitQuestions(false);
    if(!this.snapshot)return;this.current()?.canvas.finishEditing();this.home=false;this.libraryHost.hidden=true;this.work.hidden=false;this.show();
    const doc=this.documents().find(d=>d.id===id);if(!doc)return;
    if(!this.tabs.has(id)){const prior=[...this.tabs.values()].find(t=>!t.pinned&&!t.dirty&&!t.preset);if(prior){this.disposeTab(prior);this.tabs.delete(prior.doc.id);}this.mountTab(this.snapshot.documents.find(d=>d.id===id)??doc,pinned);}
    const t=this.tabs.get(id)!;t.pinned ||= pinned;this.directory?.remember(id);this.active=id;this.renderTabs();t.canvas.refresh();this.renderProperties();this.renderTree();
    this.rememberDocumentVisit(t,anchor);
    if(anchor)requestAnimationFrame(()=>{
      if(this.active!==id||!t.host.isConnected)return;
      const found=t.mode==='preview'?locatePresentationSection(t.preview,anchor):t.canvas.locate(anchor);
      if(!found)this.notice('章节锚点已变化，请展开当前文档重新选择。');
    });
  }
  /** 每个标签记住文档／自由视图；两种排版共用草稿和撤销链，切换不自动保存。 */
  private setMode(mode:DocumentTab['mode']){
    if(mode==='questions'){this.askQuestions();return;}
    const tab=this.current();if(!tab)return;const oldMode=tab.mode;
    const region=(oldMode==='preview'?tab.preview:tab.host.querySelector('.document-canvas-viewport')) as HTMLElement|undefined;
    const rect=region?.getBoundingClientRect();const focus=region&&[...region.querySelectorAll<HTMLElement>('[data-block-id]')].find(el=>{const r=el.getBoundingClientRect();return !el.hidden&&r.bottom>(rect?.top??0)+15&&r.top<(rect?.bottom??0);})?.dataset.blockId;
    tab.canvas.finishEditing();tab.mode=mode;
    if(mode!=='preview')tab.reordering=false;
    this.renderTabs();this.rememberDocumentVisit(tab);if(mode==='edit'){tab.canvas.refresh();if(oldMode==='preview'&&focus)tab.canvas.locate(focus);}else if(mode==='preview'&&oldMode==='edit'&&focus)tab.preview.querySelector<HTMLElement>(`[data-block-id="${focus}"]`)?.scrollIntoView({block:'start'});
  }
  /** 文档历史保留模式、滚动与镜头，恢复时使用现有草稿标签。 */
  private rememberDocumentVisit(tab:DocumentTab,anchor=''){
    const project=this.snapshot?.project.id;if(!project)return;historyScope(project);const mode=tab.mode;let scroll=tab.preview.scrollTop,pan=tab.canvas.readingPosition();
    recordVisit(`document:${tab.doc.id}:${mode}:${anchor}`,()=>{if(this.snapshot?.project.id!==project||!this.documents().some(doc=>doc.id===tab.doc.id))throw new Error('该文档已删除，无法返回。');this.openDocument(tab.doc.id,true);this.setMode(mode);const current=this.current()!;requestAnimationFrame(()=>{current.preview.scrollTop=scroll;current.canvas.restoreReadingPosition(pan);});},()=>{if(tab.preview.isConnected){scroll=tab.preview.scrollTop;pan=tab.canvas.readingPosition();}});
  }
  private updateHistoryButtons(){this.menu?.querySelectorAll<HTMLButtonElement>('[data-browse]').forEach(button=>button.disabled=!canBrowse(button.dataset.browse as 'back'|'forward'));}
  private renderMode(tab:DocumentTab){
    const projection=this.snapshot?.collaboration?.documents.find(d=>d.id===tab.doc.id);
    if(projection)tab.mode='preview';
    tab.canvas.setReadOnly(this.isDocumentLocked(tab.doc.id));
    const mode=tab.mode,locked=this.isDocumentLocked(tab.doc.id);this.work.classList.toggle('reading-document',mode!=='edit');tab.host.classList.toggle('is-document-locked',locked);
    this.tree.hidden=false;this.questionNav.hidden=true;
    const count=this.questionStats?.pending??this.projectPendingCount();this.updateQuestionBrand();
    this.modeHost.innerHTML=`<button data-doc-mode="preview" aria-pressed="${mode==='preview'}">文档视图</button><button data-doc-mode="edit" aria-pressed="${mode==='edit'}">自由视图</button><button data-doc-mode="questions" aria-pressed="${mode==='questions'}">策问${count?' '+count:''}</button>${mode==='preview'?`<button data-order aria-pressed="${tab.reordering}" ${locked?'disabled':''}>${tab.reordering?'完成排序':'调整顺序'}</button>`:''}<button class="document-lock" data-document-lock aria-pressed="${locked}" aria-label="${this.snapshot?.historical?'历史版本只读':locked?'解锁文档':'锁定文档'}" title="${this.snapshot?.historical?'历史版本只读':locked?'解锁文档，恢复编辑':'锁定文档，保护内容与属性'}" ${this.snapshot?.historical||this.snapshot?.collaboration?.locks[tab.doc.id]?'disabled':''}></button>`;
    this.modeHost.querySelector('[data-document-lock]')!.append(createElement(locked?Lock:LockOpen,{'stroke-width':1.65,'aria-hidden':'true'}));
    this.modeHost.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(b?.dataset.docMode)this.setMode(b.dataset.docMode as DocumentTab['mode']);if(b?.hasAttribute('data-document-lock'))this.toggleDocumentLock(tab);if(b?.hasAttribute('data-order')&&this.allowWrite(tab.doc.id)){tab.canvas.finishEditing();tab.reordering=!tab.reordering;this.renderTabs();}};
    if(mode==='preview'){
      const text=projection?.text??tab.canvas.read().markdown,key=JSON.stringify([text,tab.reordering,tab.dirty,locked,this.snapshot!.revision,tab.assets]);
      if(tab.previewKey!==key&&!tab.canvas.isEditing){
        const scroll=tab.preview.scrollTop;tab.disposePreview?.();tab.preview.replaceChildren();
        if(projection){const note=document.createElement('p');note.className='preview-draft-note';note.textContent='LLM 工作稿 · 尚未形成正式版本'+(tab.dirty?' · 你的未保存草稿已保留，任务结束后自由视图可继续编辑':'');tab.preview.append(note);}
        if(tab.dirty&&!projection){const notice=document.createElement('p');notice.className='preview-draft-note';notice.textContent='当前显示未保存的个人草稿 · ';const compare=document.createElement('button');compare.textContent='对比最新正式稿';compare.onclick=()=>this.comparePersonalDraft(tab);notice.append(compare);tab.preview.append(notice);}
        tab.disposePreview=mountDocumentPresentation(tab.preview,{...(projection??tab.doc),text},this.projected(),{linear:true,hideHeader:true,hideQuestions:true,draftAssets:tab.assets.filter(a=>a.text!==null).map(a=>({path:a.path,text:a.text!})),reorder:tab.reordering&&!locked,onReorder:(id,target,after)=>tab.canvas.reorder(id,target,after),onReparent:(id,parent)=>tab.canvas.changeParent(id,parent)});
        tab.previewKey=key;tab.preview.scrollTop=scroll;
      }
    }
  }
  /** 对比入口保留旧保存基准、最新正式稿与个人草稿，不自动采纳模型正文。 */
  private comparePersonalDraft(tab:DocumentTab){const formal=this.snapshot?.documents.find(doc=>doc.id===tab.doc.id);const dialog=document.createElement('dialog');dialog.className='project-dialog';const title=document.createElement('h2');title.textContent='个人草稿与最新正式稿';dialog.append(title);for(const [label,text] of [['草稿开始时的保存基准',tab.baseText??'尚未正式创建'],['最新正式稿',formal?.text??'尚无正式文档'],['保留的个人草稿',tab.canvas.read().markdown]]){const heading=document.createElement('h3'),area=document.createElement('textarea');heading.textContent=label;area.value=text;area.readOnly=true;area.rows=8;area.style.width='100%';dialog.append(heading,area);}const back=document.createElement('button');back.textContent='继续编辑个人草稿';back.disabled=!!this.snapshot?.collaboration?.locks[tab.doc.id];back.onclick=()=>{dialog.close();this.setMode('edit');};const close=document.createElement('button');close.textContent='关闭对比';close.onclick=()=>dialog.close();dialog.append(back,close);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();}
  private mountTab(doc:ProjectDocument,pinned:boolean,layout?:LayoutCompanion){
    const path=layoutCompanionPath(doc.id),companion=this.snapshot?.companions?.[path];
    if(!layout)try{layout=companion?JSON.parse(companion.text):undefined;}catch{/* 损坏布局保留原文件，服务诊断阻止保存。 */}
    this.canvases.querySelector('.document-empty')?.remove();
    const host=document.createElement('section');host.className='document-tab-content markdown-preview';host.dataset.documentId=doc.id;this.canvases.append(host);
    const tab={doc:{...doc},baseText:doc.hash?doc.text:null,baseHash:doc.hash||null,baseLayoutHash:companion?.hash??null,layout:layout??{format:1,documentId:doc.id,blocks:{}},mode:doc.hash?'preview':'edit',locked:this.personalDocumentLock(doc.id),reordering:false,dirty:false,pinned,host,assets:[]} as unknown as DocumentTab;
    const canvasHost=document.createElement('div');canvasHost.className='document-canvas-host';host.append(canvasHost);
    tab.preview=document.createElement('div');tab.preview.className='desktop-document-preview';tab.questionHost=document.createElement('section');tab.questionHost.className='desktop-round-questions';host.append(tab.preview,tab.questionHost);
    this.tabs.set(doc.id,tab);
    tab.canvas=new DocumentCanvas(canvasHost,{readOnly:this.isDocumentLocked(doc.id),inlineEditing:true,toolbarHost:this.toolbarHost,markdown:doc.text,layout:tab.layout,onFinishEditing:()=>{tab.previewKey=undefined;this.renderTabs();},onInsert:point=>this.insert({point},tab),onDocumentDrop:(item,point)=>{if(item.projectId!==this.snapshot?.project.id||!this.allowWrite(tab.doc.id))return;const source=this.documents().find(doc=>doc.id===item.documentId);if(source&&source.id!==tab.doc.id)this.documentReference(tab,source,{point});},onReimportImage:(id,source)=>this.imageMenu(tab,id,source),onLink:()=>void this.insertReference(tab).catch(error=>this.report(error)),render:text=>projectMarkdown({...tab.doc,text},this.projected(),tab.assets.filter(a=>a.text!==null).map(a=>({path:a.path,text:a.text!}))),onRender:root=>{tab.disposeMedia?.();tab.disposeMedia=mountCreativeBlocks(root,this.projected());},onChange:(text,positions)=>{if(this.isDocumentLocked(tab.doc.id))return;tab.doc.text=text;tab.layout=positions;const meta=readHeader(text).metadata;tab.doc.title=readHeader(text).body.match(/^#\s+(.+)$/m)?.[1]??tab.doc.title;tab.doc.system=String(meta.system??'');tab.doc.parent=typeof meta.parent==='string'?meta.parent:undefined;tab.doc.color=typeof meta.color==='string'&&/^#[a-f0-9]{6}$/i.test(meta.color)?meta.color:undefined;tab.dirty=true;tab.pinned=true;this.changed(tab);},onEditBlock:()=>this.notice('此块请使用对应模块的编辑入口。')});
    this.tabs.set(doc.id,tab);
    host.addEventListener('click',e=>this.moduleClick(e,tab));
    // 引用单击优先跳转，Alt 单击编辑引用文字；普通段落仍直接原位编辑。
    tab.preview.addEventListener('click',event=>{
      if((event.target as HTMLElement).closest('a[href]')&&!event.altKey)return;
      if(this.isDocumentLocked(tab.doc.id)||tab.reordering||event.ctrlKey||event.metaKey||event.shiftKey||(event.target as HTMLElement).closest('button,input,textarea,.canvas-inline-editor,.design-code-block,.creative-inline'))return;
      const row=(event.target as HTMLElement).closest<HTMLElement>('.cewen-document-source-block[data-block-id]'),id=row?.dataset.blockId;
      if(id&&(event.target as HTMLElement).closest('img')){event.preventDefault();event.stopPropagation();this.imageMenu(tab,id,parseDocumentBlocks(tab.doc.text).find(block=>block.id===id)?.source??'',event);return;}
      if(!id||!tab.canvas.canEditBlock(id))return;
      event.preventDefault();event.stopPropagation();tab.canvas.finishEditing();
      const target=tab.preview.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
      if(target)tab.canvas.editInHost(id,target,{left:event.clientX,top:event.clientY});
    },{capture:true});
    // 文档视图在实际段落落点插入标题链接；自由画布由自身 capture 处理独立引用块。
    tab.preview.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE)){event.preventDefault();event.dataTransfer.dropEffect='link';}},true);
    tab.preview.addEventListener('drop',event=>{
      if(!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();
      const item=readDocumentDrag(event.dataTransfer);if(!item||item.projectId!==this.snapshot?.project.id||!this.allowWrite(tab.doc.id))return;
      const source=this.documents().find(doc=>doc.id===item.documentId);if(!source||source.id===tab.doc.id)return;
      const target=(event.target as HTMLElement).closest<HTMLElement>('.cewen-document-source-block[data-block-id]');
      const insert=async()=>{if(target&&await tab.canvas.insertInlineReference(target.dataset.blockId!,target,{href:this.relativeDocumentLink(tab.doc.path,source.path),title:source.title,color:this.color(source)},{left:event.clientX,top:event.clientY}))return;this.documentReference(tab,source,this.insertionTarget(tab,event));};
      void insert().catch(error=>this.report(error));
    },true);
    tab.preview.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();const row=(event.target as HTMLElement).closest<HTMLElement>('.cewen-document-source-block[data-block-id]');if(row&&(event.target as HTMLElement).closest('img')){this.imageMenu(tab,row.dataset.blockId!,parseDocumentBlocks(tab.doc.text).find(block=>block.id===row.dataset.blockId)?.source??'',event);return;}this.insert(this.insertionTarget(tab,event),tab);});
    return tab;
  }
  /** 同一文档写入串行执行，旧请求不能在新请求之后覆盖个人恢复稿。 */
  private queuePersonalDraft(projectId:string,draft:DocumentDraft){const key=projectId+':'+draft.id,entry=this.draftWrites.get(key)??{projectId,draft};entry.draft=draft;if(entry.timer)clearTimeout(entry.timer);entry.timer=setTimeout(()=>this.flushPersonalDraft(key),600);this.draftWrites.set(key,entry);}
  private flushPersonalDraft(key:string){const entry=this.draftWrites.get(key);if(!entry)return Promise.resolve();if(entry.timer){clearTimeout(entry.timer);entry.timer=undefined;}const draft=structuredClone(entry.draft);entry.pending=(entry.pending??Promise.resolve()).then(async()=>{await saveDraft(entry.projectId,draft);}).catch(()=>{if(this.snapshot?.project.id===entry.projectId)this.notice('个人草稿已保留在浏览器；写入项目恢复稿暂时失败。');});return entry.pending;}
  /** 删除前清空并等待排队请求，避免已放弃的草稿被迟到请求重新创建。 */
  private async deletePersonalDraft(projectId:string,draftId:string){const key=projectId+':'+draftId;if(this.draftWrites.has(key))await this.flushPersonalDraft(key);this.draftWrites.delete(key);await deleteDraft(projectId,draftId);}
  private changed(tab:DocumentTab){
    if(!tab.preset&&this.snapshot&&!isTransientProject(this.snapshot.project.id)){const draft:DocumentDraft={id:'desktop-'+tab.doc.id,purpose:'document',documentPath:tab.doc.path,baseHash:tab.baseHash,baseText:tab.baseText,text:tab.doc.text,updatedAt:new Date().toISOString(),companions:[{path:layoutCompanionPath(tab.doc.id),baseHash:tab.baseLayoutHash,text:JSON.stringify(tab.layout)}],assets:tab.assets.map(a=>({path:a.path,text:a.text!,encoding:'base64'}))};cacheDraft(this.snapshot.project.id,draft);this.queuePersonalDraft(this.snapshot.project.id,draft);}
    // 连续输入只更新已有标签的标题和脏标记，不能重建编辑器、视图按钮或正在操作的字体浮层。
    if(tab.canvas.isEditing){const button=this.tabbar.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(tab.doc.id)}"]`);if(button){button.textContent=(tab.preset?'预设 · ':'')+tab.doc.title+(tab.dirty?' ●':'');button.parentElement?.classList.toggle('temporary',!tab.pinned);}}
    else this.renderTabs();
    this.notice(tab.preset?'预设有未保存修改。':'文档草稿已保留；保存当前文档不会保存其他标签。');
  }
  private renderTabs(){
    // 项目问答覆盖工作区，但不卸载阅读 DOM，也不把其模式写进任一文档标签。
    if(this.questionsActive){this.renderProjectQuestions();return;}
    this.projectQuestionHost.hidden=true;this.work.classList.remove('project-question-mode');this.tree.hidden=false;this.questionNav.hidden=true;
    this.overviewObserver?.disconnect();this.overviewObserver=undefined;
    this.contextDispose?.();this.contextDispose=undefined;this.canvases.querySelector('.document-context')?.remove();this.canvases.querySelector('.document-overview')?.remove();
    this.tabbar.innerHTML=[...this.tabs.values()].map(t=>`<div class="document-tab ${t.doc.id===this.active?'active':''} ${!t.pinned?'temporary':''}"><button role="tab" aria-selected="${t.doc.id===this.active}" data-tab="${h(t.doc.id)}">${t.preset?'预设 · ':''}${h(t.doc.title)}${t.dirty?' ●':''}</button><button data-close-tab="${h(t.doc.id)}" aria-label="关闭${h(t.doc.title)}">×</button></div>`).join('');
    this.tabbar.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('button');if(b?.dataset.tab){this.current()?.canvas.finishEditing();this.openDocument(b.dataset.tab,true);}if(b?.dataset.closeTab)void this.closeTab(b.dataset.closeTab).catch(err=>this.report(err));};
    this.tabbar.ondblclick=e=>{const id=(e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;if(id){this.tabs.get(id)!.pinned=true;this.renderTabs();}};
    for(const [id,t] of this.tabs){if(id===this.active)this.renderMode(t);t.host.hidden=id!==this.active;t.canvas.setToolbarVisible(id===this.active&&t.mode==='edit');t.host.querySelector<HTMLElement>('.document-canvas-host')!.hidden=t.mode!=='edit';t.preview.hidden=t.mode!=='preview';t.questionHost.hidden=t.mode!=='questions';}
    if(!this.tabs.size){
      this.canvases.innerHTML='<div class="document-empty"><h2>一份文档，一个自由画布</h2><p>从左侧打开文档，或使用“＋”创建基础文档。角色卡、地图卡和道具卡都可以从文档预设创建。</p></div>';
      // 空项目仍可进入项目策问，返回时不能残留上一工作模式的按钮与事件。
      this.modeHost.innerHTML='<button data-project-question-entry>策问</button>';this.modeHost.onclick=()=>this.askQuestions();this.updateQuestionBrand();
    }
  }

  /** 目录聚合正式文档与当前草稿，排序不会把不同层级的文档重新归属。 */
  private directorySnapshot():ProjectSnapshot{
    const source=this.snapshot!,entry=this.structure?{text:this.structure.text,hash:this.structure.baseHash}:source.projectEntry!;
    const documents=[...new Map([...source.documents.filter(d=>!this.removed.has(d.id)),...this.documents()].map(d=>[d.id,d])).values()];
    // 草稿正文尚未保存时哈希可能不变，必须比较正文和元数据，不能仅依赖正式修订。
    const key=JSON.stringify([entry.text,entry.hash,documents]);
    if(this.directoryProjection?.source===source&&this.directoryProjection.key===key)return this.directoryProjection.value;
    const knowledge=parseKnowledge([{path:'PROJECT.md',text:entry.text,hash:entry.hash},...documents]);
    const value={...source,...knowledge,documents,projectEntry:entry};
    this.directoryProjection={source,key,value};return value;
  }
  /** 卡片库读取当前项目的结构草稿，手工顺序无需等到保存后才在视图中生效。 */
  documentListSnapshot(projectId:string):ProjectSnapshot|undefined{
    return this.snapshot?.project.id===projectId?this.directorySnapshot():undefined;
  }
  private renderTree(){
    if(!this.snapshot)return;
    if(!this.directory){
      this.directory=new ProjectDirectory(this.tree,{
        getSnapshot:()=>this.directorySnapshot(),includeArchived:()=>this.includeArchived,getSelected:()=>this.active,isSelected:id=>this.selected.has(id)||id===this.active,
        onSelect:id=>{const documentId=id.split('/')[0];this.selected=new Set([documentId]);this.lastSelected=documentId;this.openDocument(id);},
        onSelectEvent:(id,event)=>{
          // 章节单击始终定位正文，不进入仅面向文档行的多选区间计算。
          if(id.includes('/'))return false;
          if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey)return false;
          const visible=[...this.tree.querySelectorAll<HTMLElement>('.project-directory-row[data-id]')].map(row=>row.dataset.id!);
          if(event.shiftKey&&visible.includes(this.lastSelected)){const a=visible.indexOf(this.lastSelected),b=visible.indexOf(id);this.selected=new Set(visible.slice(Math.min(a,b),Math.max(a,b)+1));}
          else {this.selected.has(id)?this.selected.delete(id):this.selected.add(id);this.lastSelected=id;}
          this.directory!.render();return true;
        },
        onPin:id=>this.openDocument(id,true),onGroup:()=>{},onCommit:()=>{},onError:message=>this.report(message),
        onStage:(reason,changes)=>this.stageDirectory(reason,changes),
        extraCommands:(id,category,anchor)=>[{label:category?'分类更多操作…':'文档更多操作…',separator:true,run:()=>{
          if(category)this.categoryMenu(id,anchor);else {if(!this.selected.has(id))this.selected=new Set([id]);this.docMenu(id,anchor);}
        }}],
      });
    }else this.directory.render();

  }
  /** 结构只进入草稿；移动不会顺带保存其他标签的正文。 */
  private async stageDirectory(reason:string,changes:FileChange[]):Promise<ProjectSnapshot>{
    // 提交目录草稿之前统一检查，防止从拖放、改名或批量菜单绕过文档锁。
    if(this.snapshot?.historical)throw new Error('历史版本只读。');
    for(const change of changes){const doc=this.documents().find(item=>item.path===change.path);if(doc&&this.isDocumentLocked(doc.id))throw new Error(`文档“${doc.title}”已锁定，请先解锁。`);}
    for(const change of changes){
      if(change.text===null)continue;
      if(change.path==='PROJECT.md'){this.structure={text:change.text,baseHash:this.structure?.baseHash??this.snapshot!.projectEntry!.hash};continue;}
      const doc=this.documents().find(d=>d.path===change.path);if(!doc)continue;
      const meta=readHeader(change.text).metadata;
      const next={system:String(meta.system??''),parent:typeof meta.parent==='string'&&meta.parent?meta.parent:undefined};
      const hierarchyOnly=setMetadata(doc.text,{system:undefined,parent:undefined})===setMetadata(change.text,{system:undefined,parent:undefined});
      if(hierarchyOnly){
        this.moves.set(doc.id,next);
        const tab=this.tabs.get(doc.id);
        if(tab){tab.doc={...tab.doc,...next,text:setMetadata(tab.doc.text,{system:next.system||undefined,parent:next.parent})};tab.canvas.relocate(next.system,next.parent);}
      }else{
        const tab=this.tabs.get(doc.id)??this.mountTab(doc,true);tab.canvas.replace(change.text);
      }
    }
    this.renderTabs();this.renderProperties();this.notice(reason+' · 已暂存，保存全部后写入项目。');
    return this.directorySnapshot();
  }
  private docMenu(id:string,anchor:HTMLElement,event?:MouseEvent){showAppMenu([{label:'卡片关系预览',run:()=>this.graphView(undefined,id)},{label:'复制文档链接',run:()=>navigator.clipboard.writeText(location.origin+location.pathname+'?project='+this.snapshot!.project.id+'#cewen-doc='+encodeURIComponent(id))},{label:'重命名…',shortcut:shortcutLabel('rename'),run:()=>this.rename(id)},{label:`移动 ${this.selected.size||1} 份文档到…`,run:()=>this.moveDialog()},{label:'加入收藏分类…',run:()=>this.directory?.chooseFavoriteCategories([...this.selected].length?[...this.selected]:[id])},{label:'在目录中定位',run:()=>this.reveal(id)},{label:'独立复制文档',run:()=>this.duplicate(id)},{label:'保存为文档预设…',run:()=>{this.openDocument(id,true);return this.capturePreset();}},{label:'归档所选文档',separator:true,run:()=>this.archiveSelected()},{label:'删除所选文档…',danger:true,run:()=>this.deleteDocuments()}],anchor,event?{x:event.clientX,y:event.clientY}:undefined);}
  private categoryMenu(id:string,anchor:HTMLElement,event?:MouseEvent){showAppMenu([{label:'在此新建文档',run:()=>this.newDocument(id)},{label:'新建子分类…',run:()=>this.newCategory(id)},{label:'分类卡片视图',run:()=>this.cards(id)},{label:'分类颜色…',disabled:!id,run:()=>this.changeCategoryColor(id)},{label:'重命名分类…',disabled:!id,run:()=>this.renameCategory(id)},{label:'移动分类…',disabled:!id,run:()=>this.moveCategory(id)},{label:'删除分类，保留文档…',disabled:!id,danger:true,run:()=>this.removeCategory(id)}],anchor,event?{x:event.clientX,y:event.clientY}:undefined);}
  /** 工具留在上半部，自动应用的精简属性集中在下方三分之一，不重复目录入口。 */
  private renderProperties(){
    this.inspector.onclick=null;this.inlineDispose?.();this.inlineDispose=undefined;this.inspector.replaceChildren();
    this.tools.render();this.inspector.append(this.tools.root);const tab=this.current();if(!tab)return;
    const meta=readHeader(tab.doc.text).metadata,tags=[...new Set([...(Array.isArray(meta.tags)?meta.tags.map(String):[]),...(typeof meta.purpose==='string'&&meta.purpose?[meta.purpose]:[])])];
    const properties=document.createElement('section');properties.className='document-compact-properties';properties.setAttribute('aria-label','文档属性');
    properties.innerHTML=`<header><h3>${tab.preset?'预设属性':'文档属性'}</h3></header><form><label>名称<input name="title" aria-label="文档名称" value="${h(tab.doc.title)}" maxlength="200" required/></label><label>标签<input name="tags" aria-label="文档标签" value="${h(tags.join('，'))}" placeholder="用逗号分隔"/></label><div class="document-property-bottom"><label>状态<select name="status" aria-label="文档状态">${[['draft','草稿'],['question','待确认'],['confirmed','已确认'],['archived','已归档']].map(([value,label])=>`<option value="${value}" ${meta.status===value?'selected':''}>${label}</option>`).join('')}</select></label><button type="button" data-file-location>文件位置 ↗</button></div></form>`;
    this.inspector.append(properties);const form=properties.querySelector('form')!;
    // 旧用途只在用户实际修改本页属性时迁入标签，不批量重写历史或其他文档。
    form.onsubmit=event=>{event.preventDefault();if(!this.allowWrite(tab.doc.id))return;const data=new FormData(form),title=String(data.get('title')).trim();if(!title)return;tab.canvas.finishEditing();tab.doc.title=title;tab.doc.status=String(data.get('status')) as ProjectDocument['status'];tab.canvas.replace(setTitle(setMetadata(tab.doc.text,{purpose:undefined,tags:[...new Set(String(data.get('tags')).split(/[,，]/).map(value=>value.trim()).filter(Boolean))],status:tab.doc.status}),title));this.renderTree();};
    form.oninput=event=>{if(!(event as InputEvent).isComposing)form.dispatchEvent(new Event('submit',{cancelable:true}));};form.addEventListener('compositionend',()=>form.dispatchEvent(new Event('submit',{cancelable:true})));
    properties.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select').forEach(control=>control.disabled=this.isDocumentLocked(tab.doc.id));
    properties.querySelector<HTMLButtonElement>('[data-file-location]')!.onclick=()=>void this.revealFile(tab).catch(error=>this.report(error));
    if(this.isDocumentLocked(tab.doc.id)){const note=document.createElement('p');note.className='document-lock-note';note.textContent=this.snapshot?.historical?'历史版本只读':'文档已锁定';properties.append(note);}
  }
  /** 桌面按文档身份打开文件位置；网页只提供可复制路径，不请求任意本机执行。 */
  private async revealFile(tab:DocumentTab){
    if(window.cewenDesktop&&!isTransientProject(this.snapshot!.project.id)&&!tab.preset){await window.cewenDesktop.revealDocument(this.snapshot!.project.id,tab.doc.id);return;}
    await appForm('文件位置',`<p>${h(tab.preset||isTransientProject(this.snapshot!.project.id)?'此文档尚在临时会话中，保存为项目后才有磁盘位置。':this.snapshot!.project.path.replace(/[\\/]$/,'')+'/'+tab.doc.path)}</p>`,'关闭',()=>true);
  }
  private revealInspector(){this.work.classList.remove('hide-properties');if(innerWidth<1000)this.work.classList.add('show-properties');}
  private moduleClick(event:MouseEvent,tab:DocumentTab){
    const b=(event.target as HTMLElement).closest<HTMLElement>('[data-confirm-decision],[data-object-reference],[data-object-copy],[data-source-document],[data-object-edit],[data-object-open],[data-sequence-play],[data-quest-open],[data-quest-target],[data-production-open],a[href^="#cewen-doc="]');if(!b)return;event.preventDefault();event.stopPropagation();
    if(b instanceof HTMLAnchorElement){this.openDocument(decodeURIComponent(b.hash.slice(11)).split('/')[0],true);return;}
    if(b.dataset.sourceDocument){this.openDocument(b.dataset.sourceDocument,true);return;}
    if((b.dataset.objectReference||b.dataset.objectCopy||b.dataset.confirmDecision||b.dataset.objectEdit)&&!this.allowWrite(tab.doc.id))return;
    const index=buildCreativeIndex(this.projected());
    if(b.dataset.objectReference){const object=moduleRegistry.get('reference')!.create('ref-'+crypto.randomUUID(),'共享引用');object.data.objectId=b.dataset.objectReference;tab.canvas.append(objectBlock(object));}
    if(b.dataset.objectCopy){const source=index.objects.find(o=>o.object.id===b.dataset.objectCopy);if(source)tab.canvas.append(objectBlock(cloneCreativeObject(source.object,'object-'+crypto.randomUUID(),()=> 'row-'+crypto.randomUUID())));}
    if(b.dataset.confirmDecision)void this.contextual('confirm-decision',b.dataset.confirmDecision);
    if(b.dataset.objectEdit){const item=index.objects.find(o=>o.object.id===b.dataset.objectEdit);if(!item)return;this.openModule(item.object.id);}
    if(b.dataset.objectOpen){const item=index.objects.find(o=>o.object.id===b.dataset.objectOpen);if(item)this.openDocument(item.documentId,true);}
    if(b.dataset.sequencePlay)void this.contextual('play',b.dataset.sequencePlay);
    if(b.dataset.questOpen||b.dataset.productionOpen)void this.contextual(b.dataset.questOpen?'open-quest':'production',b.dataset.questOpen||b.dataset.productionOpen);
    if(b.dataset.questTarget)void openCollaboration('inquiry',this.projected(),[tab.doc.id]);
  }
  /** 排演、问策与生产作为当前文档的上下文视图，退出回到同一画布。 */
  private async contextual(action:string,objectId?:string){
    const tab=this.current();if(!tab)return;
    if(action==='open-quest'){this.setMode('questions');return;}
    if(action!=='play'&&!this.allowWrite(tab.doc.id))return;
    if(action!=='play'&&tab.dirty){const choice=await appChoice('先保存所选文档','此操作读取已保存的模块。当前文档需要先保存，其他标签草稿保持独立。',[{id:'save',label:'保存当前文档后继续'},{id:'cancel',label:'返回编辑'}]);if(choice!=='save')return;await this.save();if(this.current()?.dirty)return;}
    this.contextDispose?.();this.canvases.querySelector('.document-context')?.remove();for(const t of this.tabs.values()){t.host.hidden=true;t.canvas.setToolbarVisible(false);}
    const panel=document.createElement('section');panel.className='document-context';const back=document.createElement('button');back.textContent='← 返回 '+tab.doc.title;back.onclick=()=>{this.renderTabs();this.renderProperties();};const host=document.createElement('div');panel.append(back,host);this.canvases.append(panel);
    if(action==='play'){const player=new AnimaticPlayer(host,this.projected(),buildCreativeIndex(this.projected()),objectId!);this.contextDispose=()=>player.dispose();return;}
    const workspace=new CreativeWorkspace(host,s=>{this.receive(s);this.options.apply(s);},()=>this.options.proposals(),true);workspace.receive(this.snapshot!);this.contextDispose=()=>workspace.deactivate();await workspace.handle({action,objectId});
    host.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-object-open],[data-object-edit]');if(!button)return;event.stopPropagation();this.renderTabs();this.renderProperties();const item=buildCreativeIndex(this.projected()).objects.find(o=>o.object.id===(button.dataset.objectEdit||button.dataset.objectOpen));if(item){this.openDocument(item.documentId,true);if(button.dataset.objectEdit)this.openModule(item.object.id);}});
  }
  /** 旧书签和模块深链统一定位回拥有它的基础文档。 */
  async handleCreative(detail:{action:string;objectId?:string;documentId?:string}){if(detail.action==='new-project'){await this.newProject();return;}const item=buildCreativeIndex(this.projected()).objects.find(o=>o.object.id===detail.objectId);if(item)this.openDocument(item.documentId,true);else if(detail.documentId)this.openDocument(detail.documentId,true);if(detail.action==='edit'&&item)this.openModule(item.object.id);else if(['play','production','open-quest','confirm-decision'].includes(detail.action))await this.contextual(detail.action,detail.objectId);else if(detail.action==='catalog')this.insert();else if(detail.action==='quest'&&this.current())await openCollaboration('inquiry',this.projected(),[this.current()!.doc.id]);}
  private openModule(id:string){if(!this.allowWrite())return;this.current()?.canvas.finishEditing();this.revealInspector();this.renderProperties();
    const snapshot=this.projected(),item=buildCreativeIndex(snapshot).objects.find(o=>o.object.id===id);if(!item)return;
    const tab=this.tabs.get(item.documentId);if(!tab)return;
    if(!this.allowWrite(tab.doc.id))return;
    if(['production','media'].includes(item.object.type)){this.notice('媒体请重新导入新版本；生产批次通过候选审核操作。');return;}
    this.inlineDispose?.();this.inlineDispose=undefined;this.inspector.onclick=null;
    const update=(object:import('../shared/creative/model').CreativeObject)=>{if(!this.allowWrite(tab.doc.id))return;const current=buildCreativeIndex(this.projected()).objects.find(o=>o.object.id===id);if(!current)return;tab.canvas.replace(tab.doc.text.slice(0,current.start)+objectBlock(object)+tab.doc.text.slice(current.end));};
    const editorHost=this.tools.root.querySelector<HTMLElement>('.document-tool-content')!;editorHost.replaceChildren();
    const editor=openObjectEditor({object:item.object,index:buildCreativeIndex(snapshot),snapshot,documentId:item.documentId,onSaved:()=>{},host:editorHost,onWorkingDraft:update,onDraft:object=>{update(object);this.renderProperties();}});
    this.inlineDispose=()=>editor.dispatchEvent(new Event('cewen:dispose'));
  }
  /** 右键插入只打开当前落点菜单，不切换右侧工具或属性分页。 */
  private insert(at:InsertionTarget={},tab=this.current()){
    if(!tab||!this.allowWrite(tab.doc.id))return;tab.canvas.finishEditing();
    const add=(source:string)=>this.insertContent(tab!,source,at);
    const modules=(types:string[])=>types.flatMap(type=>{const module=moduleRegistry.get(type);return module?[{label:module.title,run:()=>{const object=module.create('object-'+crypto.randomUUID());if(object.type==='speech')object.data.text='待填写对白';if(object.type==='quest')object.data.goal='待填写目标';add(objectBlock(object));}}]:[];});
    // 每个模块只出现在一个用途分类；新增类型自动放入设计分类，避免丢失插入入口。
    const groups=[['正文与引用',['reference']],['图片与媒体',[]],['角色与地点',['character','location','map','map-use']],['剧情与演出',['storyline','scene','voice','speech','shot','sequence']],['设计与决策',['fields','decision','quest']]] as [string,string[]][];
    const assigned=new Set(groups.flatMap(([,types])=>types));groups[4][1].push(...[...moduleRegistry.keys()].filter(type=>!assigned.has(type)&&!['media','production','document-reference'].includes(type)));
    const commands:AppCommand[]=groups.map(([label,types],index)=>({label,children:[...(index===0?[{label:'文字',run:()=>add('单击此处编辑文字。')},{label:'章节标题',run:()=>add('## 新章节')},{label:'文档引用…',run:()=>this.insertReference(tab!,at)}]:index===1?[{label:'图片…',run:()=>this.importImage(tab!,at)},{label:'音频 / 媒体…',run:()=>this.importMedia(tab!,at)}]:[]),...modules(types)]}));
    showAppMenu(commands,tab.host,at.client??(at.point?tab.canvas.clientAt(at.point):undefined));
  }
  private insertionTarget(tab:DocumentTab,event:MouseEvent):InsertionTarget{
    if(tab.mode==='edit')return {point:tab.canvas.at(event.clientX,event.clientY),client:{x:event.clientX,y:event.clientY}};
    const row=(event.target as HTMLElement).closest<HTMLElement>('.cewen-document-source-block[data-block-id]')??[...tab.preview.querySelectorAll<HTMLElement>('.cewen-document-source-block[data-block-id]')].filter(item=>item.getBoundingClientRect().top<=event.clientY).at(-1);
    return {afterId:row?.dataset.blockId,client:{x:event.clientX,y:event.clientY}};
  }
  private insertContent(tab:DocumentTab,source:string,at:InsertionTarget={}){if(!this.allowWrite(tab.doc.id))return [];return tab.mode==='edit'&&at.point?tab.canvas.appendAt(source,at.point):tab.canvas.insertAfter(source,at.afterId);}
  private imageMenu(tab:DocumentTab,id:string,source:string,event?:MouseEvent){
    if(!this.allowWrite(tab.doc.id))return;
    showAppMenu([{label:'重新导入图片…',run:()=>this.importImage(tab,{}, {id,source})},{label:'插入另一张图片…',run:()=>this.importImage(tab,event?this.insertionTarget(tab,event):{afterId:id})}],tab.host,event?{x:event.clientX,y:event.clientY}:undefined);
  }
  private chooseFile(accept:string):Promise<File|undefined>{return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept=accept;input.onchange=()=>resolve(input.files?.[0]);input.oncancel=()=>resolve(undefined);input.click();});}
  /** 图片尺寸来自真实解码结果，替换仅进入当前草稿，保留原块身份与引用。 */
  private async importImage(tab:DocumentTab,at:InsertionTarget={},replacement?:{id:string;source:string}){
    if(!this.allowWrite(tab.doc.id))return;const file=await this.chooseFile('image/png,image/jpeg,image/webp,image/gif');if(!file||!this.tabs.has(tab.doc.id)||!this.allowWrite(tab.doc.id))return;
    if(file.size>12*1024*1024)throw new Error('图片超过12 MiB，请先缩小后导入。');
    const bitmap=await createImageBitmap(file),width=bitmap.width;bitmap.close();
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    const extension=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'} as Record<string,string>)[file.type];if(!extension)throw new Error('请选择PNG、JPEG、WebP或GIF图片。');
    const path=`docs/assets/image-${crypto.randomUUID()}.${extension}`,src=this.relativeDocumentLink(tab.doc.path,path),markup=sizedImageMarkup({src,alt:file.name,title:'',width:Math.min(width,620)});
    if(replacement){
      if(parseDocumentBlocks(tab.doc.text).find(block=>block.id===replacement.id)?.source!==replacement.source)throw new Error('图片块已变化，请重新选择。');
      let start=-1,end=-1;const find=(node:import('mdast').Nodes)=>{if(start>=0)return;if(node.type==='image'||node.type==='html'&&parseSizedImage(node.value)){start=node.position?.start.offset??-1;end=node.position?.end.offset??-1;}else if('children' in node)node.children.forEach(find);};find(fromMarkdown(replacement.source));
      if(start<0||end<0)throw new Error('当前块不是可替换的图片。');
      tab.assets.push({path,text:btoa(binary),encoding:'base64',baseHash:null});
      if(!tab.canvas.replaceBlock(replacement.id,replacement.source.slice(0,start)+markup+replacement.source.slice(end)))throw new Error('图片块已变化，请重新选择。');
    }else{tab.assets.push({path,text:btoa(binary),encoding:'base64',baseHash:null});this.insertContent(tab,markup,at);}
    this.notice('图片已进入文档草稿，保存时写入项目。');
  }
  /** 导入仅写当前文档草稿与内存播放地址，用户保存时才登记正式媒体。 */
  private async importMedia(tab:DocumentTab,at:InsertionTarget={}){if(!this.allowWrite(tab.doc.id))return;if(tab.preset){const slot=moduleRegistry.get('reference')!.create('object-'+crypto.randomUUID(),'待选择媒体');this.insertContent(tab,objectBlock(slot),at);this.notice('预设已加入媒体引用占位；创建文档后再选择项目媒体。');return;}const file=await this.chooseFile('audio/*,image/*');if(!file)return;const bytes=new Uint8Array(await file.arrayBuffer()),info=detectMedia(bytes),durationMs=await mediaInput(file);const permission=await appForm('插入媒体草稿','<p>'+h(file.name)+'</p><label>许可或来源<input name="permission" placeholder="留空则记为：来源与许可待确认"/></label><p>保存当前文档时才写入项目，放弃草稿不创建素材文件。</p>','插入',data=>String(data.get('permission')??'').trim()||'来源与许可待确认');if(!permission||!this.allowWrite(tab.doc.id))return;const digest=await crypto.subtle.digest('SHA-256',bytes),hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),path='assets/objects/'+hash+'/content.'+info.extension;let text='';for(const byte of bytes)text+=String.fromCharCode(byte);if(!this.allowWrite(tab.doc.id))return;if(!this.snapshot!.media?.[path])tab.assets.push({path,text:btoa(text),encoding:'base64',baseHash:null});draftMediaUrls.set(this.snapshot!.project.id+':'+path,URL.createObjectURL(new Blob([bytes],{type:info.mime})));const existing=buildCreativeIndex(this.projected()).objects.find(o=>o.object.type==='media'&&o.object.data.sha256===hash);if(existing){const ref=moduleRegistry.get('reference')!.create('object-'+crypto.randomUUID(),file.name);ref.data.objectId=existing.object.id;this.insertContent(tab,objectBlock(ref),at);}else this.insertContent(tab,objectBlock({schema:1,id:'media-'+hash,type:'media',title:file.name,status:'draft',data:{...info,path,sha256:hash,bytes:bytes.length,durationMs,originalName:file.name,permission}}),at);this.renderProperties();}
  /** 自由视图保留独立引用对象；文档视图只写标题链接和目标分类色。 */
  private documentReference(tab:DocumentTab,source:ProjectDocument,at:InsertionTarget={}){
    if(!this.allowWrite(tab.doc.id)||source.id===tab.doc.id)return;
    if(tab.mode==='preview'){const label=source.title.replace(/[\\`*{}\[\]<>]/g,'\\$&'),href=this.relativeDocumentLink(tab.doc.path,source.path);this.insertContent(tab,textStyleOpenTag({color:this.color(source)})+`[${label}](${href})`+'</span>',at);}
    else{const object=moduleRegistry.get('document-reference')!.create('object-'+crypto.randomUUID(),source.title);object.data.documentId=source.id;this.insertContent(tab,objectBlock(object),at);}
    this.notice('已插入文档引用，源文档保持原样。');
  }
  private relativeDocumentLink(from:string,to:string){const left=from.split('/').slice(0,-1),right=to.split('/');while(left.length&&right.length&&left[0]===right[0]){left.shift();right.shift();}return [...left.map(()=> '..'),...right.map(segment=>encodeURIComponent(segment))].join('/');}
  /** 大纲临时占用上方工具区，下方文档属性仍留在同一位置。 */
  private outline(){this.revealInspector();const tab=this.current();if(!tab)return;this.inlineDispose?.();this.renderProperties();const host=this.tools.root.querySelector<HTMLElement>('.document-tool-content')!;host.innerHTML='<h3>当前文档大纲</h3>';for(const heading of tab.host.querySelectorAll<HTMLElement>('.document-canvas-content h1,.document-canvas-content h2,.document-canvas-content h3,.document-canvas-content h4')){const button=document.createElement('button');button.textContent=heading.textContent;button.style.marginLeft=(Number(heading.tagName.slice(1))-1)*10+'px';button.onclick=()=>tab.canvas.locate(heading.closest<HTMLElement>('[data-block-id]')!.dataset.blockId!);host.append(button);}}
  /** 卡片总览复用目录的四种排序，并汇总所选分类的全部后代。 */
  private cards(category?:string){
    this.exitQuestions(false);
    this.current()?.canvas.finishEditing();this.inlineDispose?.();this.overviewObserver?.disconnect();this.canvases.querySelector('.document-overview')?.remove();
    for(const tab of this.tabs.values()){tab.host.hidden=true;tab.canvas.setToolbarVisible(false);}
    const snapshot=this.directorySnapshot(),preferences=readDocumentListState(snapshot);
    const candidates=this.documents().filter(doc=>{
      if(doc.status==='archived'&&!this.includeArchived)return false;
      if(category==='system-unassigned')return doc.type!=='gdd'&&(!doc.system||doc.system==='system-unassigned');
      return category===undefined||doc.system===category||groupAncestors(snapshot,doc.system).some(group=>group.id===category);
    });
    const docs=sortDocuments(snapshot,candidates,preferences.sort,preferences.categoryPins[documentPinScope('documents',category??'')]??[]);
    // 按实际可见列行翻页，卡片及底部翻页操作始终留在同一个视口里。
    const scope=snapshot.project.id+':'+(category??'*');if(scope!==this.overviewScope){this.overviewScope=scope;this.overviewPage=0;}
    const columns=Math.max(1,Math.floor((this.canvases.clientWidth-36)/242)),rows=Math.max(1,Math.floor((this.canvases.clientHeight-132)/252)),capacity=columns*rows,pages=Math.max(1,Math.ceil(docs.length/capacity));
    this.overviewPage=Math.min(this.overviewPage,pages-1);const offset=this.overviewPage*capacity,visible=docs.slice(offset,offset+capacity);
    const timestamp=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'暂无记录';
    const overview=document.createElement('section');overview.className='document-overview';if(category!==undefined)overview.dataset.cardCategory=category;
    overview.style.setProperty('--overview-columns',String(columns));
    overview.style.setProperty('--overview-rows',String(rows));
    overview.innerHTML=`<header><div><h2>${h('文档卡片')}</h2><p>${docs.length} 份文档 · 双击打开文档</p></div><button data-card-sort aria-label="文档卡片排序">↕ ${h(documentSortLabels[preferences.sort])}</button></header><div class="document-overview-grid">${visible.map(doc=>`<button data-card-doc="${h(doc.id)}" aria-pressed="${this.selected.has(doc.id)}" style="--category-color:${this.color(doc)}"><strong>${h(doc.title)}</strong><small>${h((Array.isArray(readHeader(doc.text).metadata.tags)?(readHeader(doc.text).metadata.tags as string[]).join(' · '):''))}</small><span class="document-overview-summary">${h(readHeader(doc.text).body.replace(/\x60{3}[\s\S]*?\x60{3}/g,'').replace(/<!--[\s\S]*?-->/g,'').slice(0,150))}</span><small class="document-overview-meta"><span>创建 ${h(timestamp(doc.createdAt))}</span><span>修改 ${h(timestamp(doc.updatedAt))}</span><span>版本 ${h(doc.revisionLabel??'未入版本')}</span></small></button>`).join('')||'<p class="document-overview-empty">此分类暂无文档。</p>'}</div><footer class="document-overview-pagination"><span>${docs.length?`${offset+1}–${Math.min(offset+capacity,docs.length)} / ${docs.length}`:'0 份文档'}</span><button data-overview-page="previous" ${this.overviewPage===0?'disabled':''}>上一页</button><span>${this.overviewPage+1} / ${pages}</span><button data-overview-page="next" ${this.overviewPage===pages-1?'disabled':''}>下一页</button></footer>`;
    overview.onclick=event=>{
      const button=(event.target as HTMLElement).closest<HTMLElement>('button');if(!button)return;
      if(button.hasAttribute('data-card-sort')){showAppMenu((Object.entries(documentSortLabels) as [DocumentSort,string][]).map(([sort,label])=>({label:`${preferences.sort===sort?'✓ ':''}${label}`,run:()=>{preferences.sort=sort;saveDocumentListState(snapshot,preferences);}})),button);return;}
      if(button.dataset.overviewPage){this.overviewPage+=button.dataset.overviewPage==='next'?1:-1;this.cards(category);return;}
      // 单击只改变选择样式，不替换 DOM，确保紧随的双击事件能够命中同一张卡片。
      if(button.dataset.cardDoc){this.selected=new Set([button.dataset.cardDoc]);overview.querySelectorAll<HTMLElement>('[data-card-doc]').forEach(card=>card.setAttribute('aria-pressed',String(card.dataset.cardDoc===button.dataset.cardDoc)));}
    };
    overview.ondblclick=event=>{const id=(event.target as HTMLElement).closest<HTMLElement>('[data-card-doc]')?.dataset.cardDoc;if(id)this.openDocument(id,true);};
    overview.onkeydown=event=>{const id=(event.target as HTMLElement).closest<HTMLElement>('[data-card-doc]')?.dataset.cardDoc;if(id&&event.key==='Enter'){event.preventDefault();this.openDocument(id,true);}};
    // 同主卡片库：连续滚动只翻一页，边界消费手势，Ctrl+滚轮仍交给浏览器缩放。
    overview.addEventListener('wheel',event=>{
      if(event.ctrlKey)return;event.preventDefault();event.stopPropagation();
      const state=this.overviewWheel,now=Date.now();if(now-state.last>170){state.amount=0;state.direction=0;state.latched=false;}state.last=now;
      if(state.latched)return;const delta=Math.abs(event.deltaY)>=Math.abs(event.deltaX)?event.deltaY:event.deltaX,direction=Math.sign(delta);if(!direction)return;
      if(state.direction!==direction)state.amount=0;state.direction=direction;state.amount+=Math.abs(delta)*(event.deltaMode===1?16:event.deltaMode===2?overview.clientHeight:1);
      if(state.amount<36)return;state.latched=true;const next=Math.max(0,Math.min(pages-1,this.overviewPage+direction));if(next!==this.overviewPage){this.overviewPage=next;this.cards(category);}
    },{passive:false});
    this.canvases.append(overview);
    let page=this.overviewPage;recordVisit('document-cards:'+scope,()=>{this.show();this.overviewScope=scope;this.overviewPage=page;this.cards(category);},()=>{page=this.overviewPage;});
    this.overviewObserver=new ResizeObserver(()=>{const nextColumns=Math.max(1,Math.floor((this.canvases.clientWidth-36)/242)),nextRows=Math.max(1,Math.floor((this.canvases.clientHeight-132)/252));if(overview.isConnected&&(nextColumns!==columns||nextRows!==rows))this.cards(category);});this.overviewObserver.observe(this.canvases);
  }
  private async insertReference(tab:DocumentTab,at:InsertionTarget={}){if(!this.allowWrite(tab.doc.id))return;const id=await appForm('插入文档引用',`<label>源文档<select name="document">${this.documents().filter(d=>d.id!==tab.doc.id).map(d=>`<option value="${h(d.id)}">${h(d.title)}</option>`).join('')}</select></label>`,'插入',data=>String(data.get('document')));const doc=this.documents().find(d=>d.id===id);if(doc)this.documentReference(tab,doc,at);}
  private async newProject(){try{if(!await this.leave())return;await projectWizard(s=>this.open(s,true));}catch(error){this.report(error);throw error;}}
  async newDocument(category=''){if(!this.snapshot||this.snapshot.historical)return;this.exitQuestions(false);this.show();await this.loadPresets();const picked=await pickDocumentPreset(this.allPresets());const result=picked?{name:picked.name,preset:picked.id}:undefined;if(!result)return;const preset=this.allPresets().find(p=>p.id===result.preset),value=preset?instantiateDocumentPreset(preset,result.name):{id:'doc-'+crypto.randomUUID(),markdown:'',layout:undefined,assets:{}};const text=value.markdown||`---\nid: ${value.id}\ntype: dd\nstatus: draft\n---\n\n# ${result.name.replace(/[\r\n]/g,' ')}\n\n单击正文开始编辑，或插入模块。\n`;const doc:ProjectDocument={id:value.id,title:result.name,type:'dd',status:'draft',system:category,path:`docs/dd/${value.id}.md`,text:setMetadata(text,{system:category||undefined}),hash:''};this.canvases.querySelector('.document-empty')?.remove();const tab=this.mountTab(doc,true,value.layout);tab.assets=Object.entries(value.assets).map(([path,text])=>({path,text,baseHash:null,encoding:'base64'}));tab.dirty=true;this.active=doc.id;this.changed(tab);this.renderTree();this.renderProperties();tab.canvas.startEditing();}
  private changes(tabs:DocumentTab[],includeMoves=false){const changes:FileChange[]=[];if(includeMoves)for(const doc of this.removed.values()){if(doc.hash)changes.push({path:doc.path,text:null,baseHash:doc.hash});const layout=layoutCompanionPath(doc.id),hash=this.snapshot!.companions?.[layout]?.hash;if(hash)changes.push({path:layout,text:null,baseHash:hash});}for(const t of tabs.filter(t=>t.dirty&&!t.preset)){changes.push({path:t.doc.path,text:t.doc.text,baseHash:t.baseHash},{path:layoutCompanionPath(t.doc.id),text:JSON.stringify(t.layout,null,2),baseHash:t.baseLayoutHash},...t.assets.filter(a=>!a.path.startsWith('assets/objects/')));}if(includeMoves)for(const [id,move] of this.moves){const doc=this.snapshot!.documents.find(d=>d.id===id),tab=this.tabs.get(id);const change=changes.find(c=>c.path===(doc?.path??tab?.doc.path));if(change&&change.text)change.text=setMetadata(change.text,{system:move.system||undefined,parent:move.parent});else if(doc)changes.push({path:doc.path,baseHash:doc.hash,text:setMetadata(doc.text,{system:move.system||undefined,parent:move.parent})});}return changes;}
  async save(all=false){
    if(this.snapshot?.historical){this.notice('历史版本只读。');return;}
    for(const t of this.tabs.values()){t.canvas.finishEditing();if(t.dirty)t.layout=t.canvas.read().layout;}
    if(this.busy||!this.snapshot)return;if(this.current()?.preset&&!all){await this.savePreset(this.current()!);return;}
    if(all)for(const t of this.tabs.values())if(t.preset&&t.dirty)await this.savePreset(t);
    if(transientProjects.get(this.snapshot.project.id)==='preset')return;
    if(isTransientProject(this.snapshot.project.id)){await this.saveAs();return;}
    let tabs=(all?[...this.tabs.values()]:this.current()?[this.current()!]:[]).filter(t=>t.dirty&&!t.preset);
    // 只有尚未正式存在的引用目标需要连带保存；已有目标的其他正文草稿保持独立。
    const required=new Set(tabs),projected=this.projected(),index=buildCreativeIndex(projected),savedObjects=new Set(buildCreativeIndex(this.snapshot).objects.map(o=>o.object.id));
    for(let n=0;n<this.tabs.size;n++)for(const t of [...required]){
      for(const ref of index.references.filter(r=>r.path===t.doc.path&&!savedObjects.has(r.targetId))){const target=index.objects.find(o=>o.object.id===ref.targetId),other=target&&this.tabs.get(target.documentId);if(other?.dirty)required.add(other);}
      for(const ref of index.objects.filter(o=>o.documentId===t.doc.id&&o.object.type==='document-reference')){const other=this.tabs.get(String(ref.object.data.documentId));if(other?.dirty&&!other.baseHash)required.add(other);}
      for(const match of t.doc.text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const target=resolveDocumentLink(t.doc.path,match[1]),other=[...this.tabs.values()].find(o=>o.doc.path===target?.path);if(other?.dirty&&!other.baseHash)required.add(other);}
    }
    if(required.size>tabs.length){const added=[...required].filter(t=>!tabs.includes(t));const chosen=await appChoice('保存新引用的来源',`当前文档引用了尚未保存的资料：\n${added.map(t=>t.doc.title).join('、')}\n需要一并保存这些资料，才能形成完整版本。`,[{id:'save',label:'一并保存以上文档'},{id:'cancel',label:'取消，继续编辑'}]);if(chosen!=='save')return;tabs=[...required];}
    let includeMoves=all;
    if(!all&&this.moves.size&&tabs.some(t=>this.moves.has(t.doc.id))){const chosen=await appChoice('保存项目结构草稿',`${this.moves.size} 份文档的归属有共同修改。保存结构不会提交其他标签的正文草稿。`,[{id:'save',label:'一并保存归属修改'},{id:'cancel',label:'取消'}]);if(chosen!=='save')return;includeMoves=true;}
    if(tabs.some(t=>!this.allowWrite(t.doc.id))||includeMoves&&[...this.moves.keys(),...this.removed.keys()].some(id=>!this.allowWrite(id)))return;
    const changes=this.changes(tabs,includeMoves);
    if(this.structure&&(includeMoves||all||tabs.some(t=>!this.snapshot!.groups.some(g=>g.id===t.doc.system)&&t.doc.system))){if(!all&&!includeMoves){const chosen=await appChoice('保存所需的分类结构','当前文档使用了尚未保存的分类，需同时保存项目分类结构。其他文档草稿不会提交。',[{id:'save',label:'同时保存分类结构'},{id:'cancel',label:'返回编辑'}]);if(chosen!=='save')return;}changes.push({path:'PROJECT.md',text:this.structure.text,baseHash:this.structure.baseHash});}
    if(!changes.length){this.notice('没有需要保存的修改。');return;}
    this.busy=true;
    try{
      const snapshot=await request<ProjectSnapshot>(`/api/projects/${this.snapshot.project.id}/commit`,{projectId:this.snapshot.project.id,requestId:crypto.randomUUID(),baseRevision:this.snapshot.revision,actor:'user',reason:all?'保存全部文档与项目结构':'保存当前文档',media:tabs.flatMap(t=>t.assets.filter(a=>a.path.startsWith('assets/objects/')).map(a=>({path:a.path,text:a.text!}))),changes});
      let cleanupFailed=false;
      for(const t of tabs){const doc=snapshot.documents.find(d=>d.id===t.doc.id)!;t.doc={...doc};t.baseHash=doc.hash;t.baseText=doc.text;t.baseLayoutHash=snapshot.companions?.[layoutCompanionPath(doc.id)]?.hash??null;t.dirty=false;t.assets=[];try{await this.deletePersonalDraft(snapshot.project.id,'desktop-'+doc.id);}catch{cleanupFailed=true;}}
      if(includeMoves){this.removed.clear();for(const id of this.moves.keys()){const t=this.tabs.get(id),doc=snapshot.documents.find(d=>d.id===id);if(t&&doc&&!tabs.includes(t)){t.baseHash=doc.hash;t.baseText=doc.text;if(!t.dirty)t.doc={...doc};}}this.moves.clear();}
      if(changes.some(c=>c.path==='PROJECT.md'))this.structure=undefined;
      this.snapshot=snapshot;this.options.apply(snapshot);this.renderTree();this.renderTabs();this.notice(cleanupFailed?'已保存并形成正式版本；旧草稿缓存清理失败，可下次打开时放弃旧草稿。':'已保存并形成正式版本。');
    }catch(error){
      // 冲突时保留工作稿并展示当前磁盘稿；不自动替换保存基准或重试覆盖。
      if(['CONFLICT','FILE_CONFLICT','DEPENDENCY_CHANGED'].includes((error as {code?:string}).code??'')){this.inspector.innerHTML=`<h3>保存冲突 · 工作稿已保留</h3><p>${h((error as Error).message)}</p><p>请核对外部变化。可以先用“项目另存为”保留独立副本。</p>${tabs.map(t=>`<details><summary>${h(t.doc.title)} · 我的草稿</summary><pre>${h(t.doc.text)}</pre></details>`).join('')}`;const current=await request<ProjectSnapshot>(`/api/projects/${this.snapshot.project.id}`);for(const t of tabs){const doc=current.documents.find(d=>d.id===t.doc.id),section=document.createElement('details');section.innerHTML=`<summary>${h(t.doc.title)} · 当前磁盘稿</summary><pre>${h(doc?.text??'文档已被移除')}</pre>`;this.inspector.append(section);}}
      throw error;
    }finally{this.busy=false;}
  }
  async saveAs():Promise<boolean>{
    for(const t of this.tabs.values()){t.canvas.finishEditing();if(t.dirty)t.layout=t.canvas.read().layout;}
    if(!this.snapshot||this.busy)return false;const library=await listProjects(),old=this.snapshot.project.id,active=this.active,requestId=crypto.randomUUID();
    const next=await appForm('项目另存为',`<label>新项目名称<input name="name" value="${h(this.snapshot.project.name+' · 副本')}" required maxlength="100"/></label><label>保存父目录<input name="directory" value="${h(library.defaultDirectory)}" required/></label><p>包含当前所有文档草稿和分类结构；来源项目保持原样。成功后切换到新项目。</p><label><input type="checkbox" name="preferDrafts"/>遇到来源冲突时，在新副本中采用我的草稿（原文件不变）</label>`,'另存为新项目',async data=>{
      const changes=this.changes([...this.tabs.values()],true);if(this.structure)changes.push({path:'PROJECT.md',text:this.structure.text,baseHash:this.structure.baseHash});
      const content=isTransientProject(old)?await (await import('../browser/transient-projects')).transientContent(old):undefined;
      return request<ProjectSnapshot>('/api/projects/save-as',{name:data.get('name'),directory:data.get('directory'),requestId,preferDrafts:data.has('preferDrafts'),media:[...this.tabs.values()].flatMap(t=>t.assets.filter(a=>a.path.startsWith('assets/objects/')).map(a=>({path:a.path,text:a.text!}))),...(content?{files:content.files,workspaceItems:content.workspaceItems}:{sourceId:old}),changes});
    });if(!next)return false;this.clear();if(isTransientProject(old))(await import('../browser/transient-projects')).disposeTransient(old);this.snapshot=undefined;await this.open(next);if(this.documents().some(d=>d.id===active))this.openDocument(active,true);return true;
  }
  async closeTab(id:string){this.tabs.get(id)?.canvas.finishEditing();let tab=this.tabs.get(id);if(!tab)return;if(tab.dirty){const choice=await appChoice('关闭文档',`${tab.doc.title} 有尚未保存的修改。`,[{id:'save',label:'保存后关闭'},{id:'discard',label:'放弃当前草稿'},{id:'cancel',label:'返回编辑'}]);if(!choice||choice==='cancel')return;if(choice==='save'){this.active=id;await this.save();if(this.tabs.get(id)?.dirty)return;}else if(this.snapshot&&!isTransientProject(this.snapshot.project.id))await this.deletePersonalDraft(this.snapshot.project.id,'desktop-'+id);}tab=this.tabs.get(id);if(!tab)return;this.disposeTab(tab);this.tabs.delete(id);if(this.active===id)this.active=[...this.tabs.keys()].at(-1)??'';this.renderTabs();this.renderProperties();this.renderTree();}
  private async leave():Promise<boolean>{for(const t of this.tabs.values())t.canvas.finishEditing();if(!this.snapshot)return true;if(this.hasChanges()){const choice=await appChoice('离开当前项目','有未保存的编辑。示例关闭后会恢复原始内容。',[{id:'save',label:isTransientProject(this.snapshot.project.id)?'另存为新项目':'保存全部'},{id:'discard',label:'放弃本次未保存修改'},{id:'cancel',label:'继续编辑'}]);if(!choice||choice==='cancel')return false;if(choice==='save'){if(isTransientProject(this.snapshot.project.id)){if(!await this.saveAs())return false;}else{await this.save(true);if(this.hasChanges())return false;}}else if(!isTransientProject(this.snapshot.project.id)){for(const t of this.tabs.values())await this.deletePersonalDraft(this.snapshot.project.id,'desktop-'+t.doc.id);}}return true;}
  /** 项目库只挂起会话；删除／切换项目才经过离开确认。 */
  async closeProject(){if(!await this.leave())return;const id=this.snapshot?.project.id;this.clear();this.snapshot=undefined;if(id){forgetRoundSession(id);if(isTransientProject(id))(await import('../browser/transient-projects')).disposeTransient(id);}this.updateTitle();await this.showLibrary();}
  async showLibrary(){this.projectQuestions?.captureDraft();this.current()?.canvas.finishEditing();this.home=true;this.work.hidden=true;this.libraryHost.hidden=false;this.show();this.updateQuestionBrand();if(this.snapshot)recordVisit('library:'+this.snapshot.project.id,()=>{void this.showLibrary().catch(error=>this.report(error));});await this.library.refresh();}
  returnToProject(){if(!this.snapshot)return;this.home=false;this.libraryHost.hidden=true;this.work.hidden=false;this.show();this.renderTabs();if(this.current()&&!this.questionsActive)this.rememberDocumentVisit(this.current()!);}
  /** 任意工作视图的策问入口均进入全项目问题，不要求先打开一篇文档。 */
  askQuestions(){
    if(!this.snapshot){void this.showLibrary().then(()=>this.notice('请在项目库打开或新建项目，再进入策问模式。')).catch(error=>this.report(error));return;}
    if(this.questionsActive){this.returnToProject();return;}
    const readingReturn=!this.visible&&!this.home?this.options.captureReading?.():undefined;
    this.current()?.canvas.finishEditing();this.inlineDispose?.();this.inlineDispose=undefined;
    const overview=this.canvases.querySelector<HTMLElement>('.document-overview');
    this.questionReadingFrame={active:this.active,overview:!!overview,category:overview?.dataset.cardCategory};this.questionReadingReturn=readingReturn;
    this.overviewObserver?.disconnect();this.questionsActive=true;
    if(!this.projectQuestionHost.isConnected)this.canvases.append(this.projectQuestionHost);
    if(!this.projectQuestions)this.projectQuestions=new RoundQuestions(this.projectQuestionHost,this.questionNav,this.snapshot,'',{
      apply:s=>this.options.apply(s),back:()=>this.exitQuestions(),source:id=>this.openDocument(id,true),saveAs:()=>this.saveAs(),hasUnsaved:()=>this.hasChanges(),
      importQuestions:()=>document.getElementById('project-exchange')?.click(),
      onStateChange:stats=>{this.questionStats=stats;this.updateQuestionBrand();},
    });
    this.returnToProject();this.notice('策问模式 · 切换题目保留草稿；在本轮汇总中明确提交。');
  }
  /** 外部主导航离开时只暂存作答；下次策问仍恢复本项目的独立位置。 */
  leaveQuestionMode(){this.exitQuestions(false);}
  private exitQuestions(restore=true){
    if(!this.questionsActive)return;this.projectQuestions?.captureDraft();this.questionsActive=false;
    const frame=this.questionReadingFrame,returnToReading=this.questionReadingReturn;this.questionReadingFrame=undefined;this.questionReadingReturn=undefined;
    if(frame&&this.tabs.has(frame.active))this.active=frame.active;
    this.work.classList.remove('project-question-mode');this.projectQuestionHost.hidden=true;this.tree.hidden=false;this.questionNav.hidden=true;
    const viewTitle=document.getElementById('view-title');if(viewTitle)viewTitle.textContent='策划案';
    const heading=this.tree.parentElement?.querySelector('header strong');if(heading)heading.textContent='项目文档';
    this.renderTabs();this.renderProperties();
    if(restore&&frame?.overview)this.cards(frame.category);
    this.updateQuestionBrand();this.notice('已返回阅读，策问草稿保留。');if(restore)returnToReading?.();
  }
  private renderProjectQuestions(){
    this.work.classList.add('project-question-mode');this.tree.hidden=true;this.questionNav.hidden=false;this.projectQuestionHost.hidden=false;
    const viewTitle=document.getElementById('view-title');if(viewTitle)viewTitle.textContent='策问模式';
    if(!this.projectQuestionHost.isConnected)this.canvases.append(this.projectQuestionHost);
    const heading=this.tree.parentElement?.querySelector('header strong');if(heading)heading.textContent='项目策问';
    for(const tab of this.tabs.values()){tab.host.hidden=true;tab.canvas.setToolbarVisible(false);}
    for(const host of this.canvases.querySelectorAll<HTMLElement>('.document-empty,.document-overview,.document-context'))host.hidden=true;
    this.tabbar.innerHTML='<span class="project-question-tab">项目策问</span>';this.tabbar.onclick=null;this.tabbar.ondblclick=null;
    this.modeHost.innerHTML='<button data-return-reading>返回阅读</button><button data-doc-mode="questions" aria-pressed="true">策问模式</button>';
    this.modeHost.onclick=event=>{if((event.target as HTMLElement).closest('[data-return-reading]'))this.exitQuestions();};
    this.projectQuestions?.show(this.questionNav);this.updateQuestionBrand();recordVisit('questions:'+this.snapshot?.project.id,()=>this.askQuestions());
  }
  /** 字标数量按问题身份统计全项目未提交题，分类多来源不会重复计算。 */
  private projectPendingCount(){return this.snapshot?.documents.filter(doc=>doc.type==='question'&&doc.status!=='archived'&&inquiry(doc).status!=='answered').length??0;}
  /** 策问快捷键只操作草稿和问题导航，不能顺手保存或改名后台正文。 */
  private questionKey(event:KeyboardEvent){
    if(!this.questionsActive)return false;const action=shortcutAction(event),command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(action==='save'||action==='saveAll'){event.preventDefault();event.stopPropagation();this.projectQuestions?.captureDraft();this.notice('策问草稿已保留，正式提交请使用本轮汇总。');return true;}
    if(action==='find'||action==='findDirectory'){event.preventDefault();this.questionNav.querySelector<HTMLInputElement>('input[type=search]')?.focus();return true;}
    if(action==='close'){event.preventDefault();this.exitQuestions();return true;}
    if(event.key==='F2'||command&&['z','y','k'].includes(key))return true;
    return false;
  }
  private updateQuestionBrand(){
    const brand=document.querySelector('.brand');if(!brand)return;const active=this.questionsActive&&!this.home&&!this.root.hidden,count=this.questionStats?.pending??this.projectPendingCount();
    brand.classList.toggle('is-question-mode',active);brand.setAttribute('aria-pressed',String(active));brand.setAttribute('aria-label',`策问：项目有 ${count} 个待答问题${active?'，当前处于策问模式':''}`);
    let badge=brand.querySelector<HTMLElement>('.brand-question-count');if(count){if(!badge){badge=document.createElement('span');badge.className='brand-question-count';brand.append(badge);}badge.textContent=String(count);badge.title='项目待答问题';}else badge?.remove();
  }

  /** 原位改名：Enter 确认，Esc 或离开取消，不阻断其他文档。 */
  private async rename(id=this.active){if(this.allowWrite(id))this.directory?.rename(id);}
  private setGroups(groups:KnowledgeGroup[]){if(this.snapshot?.historical)return;const entry=this.structure??this.snapshot!.projectEntry!;this.structure={text:setMetadata(entry.text,{systems:groups.map(g=>({id:g.id,title:g.label,color:g.color,...(g.parent?{parent:g.parent}:{})}))}),baseHash:'baseHash' in entry?entry.baseHash:entry.hash};this.renderTree();this.notice('分类结构已修改，保存全部后形成正式版本。');}
  /** 分类颜色来自同一 PROJECT.md；浅色主题映射也与原图谱共用。 */
  private color(doc:ProjectDocument){return categoryColor(doc.color??this.groups().find(g=>g.id===doc.system)?.color??'#94A5BC');}
  private async changeCategoryColor(id:string){const group=this.groups().find(g=>g.id===id);if(!group)return;const color=await appForm('分类颜色','<label>颜色<input type="color" name="color" value="'+h(group.color)+'"/></label><p>保存全部后，星空、分类分层、思维导图和关系卡片同步采用此颜色。</p>','应用到结构草稿',data=>String(data.get('color')));if(color)this.setGroups(this.groups().map(g=>g.id===id?{...g,color}:g));}
  private async newCategory(parent?:string){const name=await appForm('新建分类','<label>分类名称<input name="name" required maxlength="80"/></label>','新建',data=>String(data.get('name')));if(name)this.setGroups([...this.groups(),{id:'category-'+crypto.randomUUID(),label:name,color:'#7CBFFF',...(parent?{parent}:{})}]);}
  private reveal(id:string){this.directory?.reveal(id);}
  private async duplicate(id:string){const source=this.documents().find(d=>d.id===id);if(!source)return;const tab=this.tabs.get(id),preset=captureDocumentPreset(source.text,source.title+' · 副本',true,tab?.layout);const value=instantiateDocumentPreset(preset);const doc={...source,id:value.id,path:'docs/dd/'+value.id+'.md',title:preset.name,text:setMetadata(value.markdown,{system:source.system,parent:source.parent}),hash:''};const created=this.mountTab(doc,true,value.layout);created.dirty=true;this.active=doc.id;this.changed(created);this.renderTree();this.renderProperties();}
  private async moveCategory(id:string){const groups=this.groups(),descendants=new Set([id]);for(let i=0;i<groups.length;i++)for(const g of groups)if(g.parent&&descendants.has(g.parent))descendants.add(g.id);const parent=await appForm('移动分类','<label>目标父分类<select name="parent"><option value="">顶层</option>'+groups.filter(g=>!descendants.has(g.id)).map(g=>'<option value="'+h(g.id)+'">'+h(g.label)+'</option>').join('')+'</select></label><p>文档归属不变，整个子分类树随之移动。</p>','移动',data=>String(data.get('parent')));if(parent!==undefined)this.setGroups(groups.map(g=>g.id===id?{...g,parent:parent||undefined}:g));}
  private async removeCategory(id:string){const group=this.groups().find(g=>g.id===id);if(!group)return;const answer=await appChoice('删除分类','分类内文档和子分类会移到上一层，正文及引用保留。',[{id:'cancel',label:'取消'},{id:'remove',label:'删除分类并保留资料'}]);if(answer!=='remove'||this.documents().filter(d=>d.system===id).some(doc=>!this.allowWrite(doc.id)))return;for(const doc of this.documents().filter(d=>d.system===id))this.moves.set(doc.id,{system:group.parent??'',parent:doc.parent});this.setGroups(this.groups().filter(g=>g.id!==id).map(g=>g.parent===id?{...g,parent:group.parent}:g));}
  private async renameCategory(id:string){const g=this.groups().find(g=>g.id===id);if(!g)return;const name=await appForm('重命名分类',`<label>名称<input name="name" required value="${h(g.label)}"/></label>`,'更新',data=>String(data.get('name')));if(name)this.setGroups(this.groups().map(g=>g.id===id?{...g,label:name}:g));}
  private async moveDialog(){if([...this.selected].some(id=>!this.allowWrite(id)))return;const result=await appForm('移动文档',`<p>主归属只有一个。移动时会包含所选文档的后代。</p><label>目标分类<select name="category"><option value="">未分类</option>${this.groups().map(g=>`<option value="${h(g.id)}">${h(g.label)}</option>`).join('')}</select></label><label>作为子文档（可选）<select name="parent"><option value="">直接位于分类下</option>${this.documents().filter(d=>!this.selected.has(d.id)).map(d=>`<option value="${h(d.id)}">${h(d.title)}</option>`).join('')}</select></label>`,'查看移动范围',data=>({category:String(data.get('category')),parent:String(data.get('parent'))}));if(result)await this.moveDocuments(result.category,result.parent||undefined);}
  private async moveDocuments(category?:string,parent?:string){const docs=this.documents(),ids=new Set(this.selected);for(let i=0;i<docs.length;i++)for(const d of docs)if(d.parent&&ids.has(d.parent))ids.add(d.id);if(parent&&ids.has(parent))throw new Error('不能移动到自身或后代文档。');if(parent)category=docs.find(d=>d.id===parent)?.system??'';const names=docs.filter(d=>ids.has(d.id));if(names.some(doc=>!this.allowWrite(doc.id)))return;const confirm=await appChoice('确认移动范围',`${names.map(d=>d.title).join('、')}\n共 ${names.length} 份文档 → ${parent?docs.find(d=>d.id===parent)?.title:this.groups().find(g=>g.id===category)?.label||'未分类'}`,[{id:'move',label:'更新这些文档的草稿'},{id:'cancel',label:'取消'}]);if(confirm!=='move'||names.some(doc=>!this.allowWrite(doc.id)))return;for(const doc of names){let tab=this.tabs.get(doc.id);if(!tab)tab=this.mountTab(doc,true);const nextParent=doc.parent&&ids.has(doc.parent)?doc.parent:parent;this.moves.set(doc.id,{system:category??'',parent:nextParent});tab.doc={...tab.doc,system:category??'',parent:nextParent,text:setMetadata(tab.doc.text,{system:category||undefined,parent:nextParent})};tab.canvas.relocate(category??'',nextParent);}this.renderTree();this.renderProperties();}
  /** 文档删除先进入项目结构草稿；正式保存仍受引用完整性与哈希冲突检查。 */
  /** 图谱文档删除仍进入既有结构草稿和明确范围确认，不立即删除公开文件。 */
  async deleteFromGraph(ids:string[]){if(!this.snapshot||this.snapshot.historical||!ids.length)return;const nodes=this.snapshot.nodes.filter(node=>ids.includes(node.id));const documents=nodes.filter(node=>node.kind==='document'&&node.documentType!=='gdd').map(node=>node.documentId);if(!documents.length){const first=nodes[0];if(first?.documentId){this.openDocument(first.anchor?first.documentId+'/'+first.anchor:first.documentId,true);this.notice('已打开来源文档，请在正文中选择要删除的章节或文字。');}return;}this.show();this.selected=new Set(documents);await this.deleteDocuments();}
  private async deleteDocuments(){const docs=this.documents(),ids=new Set(this.selected);for(let i=0;i<docs.length;i++)for(const doc of docs)if(doc.parent&&ids.has(doc.parent))ids.add(doc.id);const selected=docs.filter(d=>ids.has(d.id));if(!selected.length||selected.some(doc=>!this.allowWrite(doc.id)))return;const result=await appChoice('删除文档草稿',selected.map(d=>d.title).join('、')+'\n保存全部后才删除公开文件。历史版本仍保留；若还有引用，需要先处理来源文档。',[{id:'cancel',label:'取消'},{id:'delete',label:'将这些文档标记为删除'}]);if(result!=='delete'||selected.some(doc=>!this.allowWrite(doc.id)))return;for(const doc of selected){const original=this.snapshot!.documents.find(d=>d.id===doc.id);if(original)this.removed.set(doc.id,original);const tab=this.tabs.get(doc.id);if(tab)this.disposeTab(tab);this.tabs.delete(doc.id);this.moves.delete(doc.id);if(!isTransientProject(this.snapshot!.project.id))await this.deletePersonalDraft(this.snapshot!.project.id,'desktop-'+doc.id);}this.active=[...this.tabs.keys()].at(-1)??'';this.selected.clear();this.renderTabs();this.renderProperties();this.renderTree();this.notice('删除已加入项目结构草稿，请保存全部；关闭项目可放弃。');}
  private async archiveSelected(){if([...this.selected].some(id=>!this.allowWrite(id)))return;for(const id of this.selected){const doc=this.documents().find(d=>d.id===id);if(!doc)continue;const tab=this.tabs.get(id)??this.mountTab(doc,true);tab.doc.status='archived';tab.canvas.replace(setMetadata(tab.doc.text,{status:'archived'}));}this.renderTree();}
  private async recoverDrafts(){if(!this.snapshot||isTransientProject(this.snapshot.project.id))return;const id=this.snapshot.project.id,drafts=(await projectDrafts(id)).filter(d=>d.id.startsWith('desktop-'));if(!drafts.length)return;const answer=await appChoice('发现未保存的文档草稿',`${drafts.length} 份草稿。正式文档不会被覆盖，恢复后仍需要保存。`,[{id:'recover',label:'恢复到标签页'},{id:'discard',label:'放弃这些旧草稿'},{id:'later',label:'暂不处理'}]);if(this.snapshot?.project.id!==id)return;if(answer==='discard'){for(const d of drafts)await this.deletePersonalDraft(id,d.id);}if(answer!=='recover')return;for(const d of drafts){const meta=readHeader(d.text).metadata,doc=this.documents().find(v=>v.path===d.documentPath)??{id:String(meta.id),title:'恢复文档',type:'dd' as const,status:'draft' as const,system:String(meta.system??''),text:d.text,path:d.documentPath,hash:''};this.openDocument(doc.id,true);const t=this.tabs.get(doc.id)??this.mountTab(doc,true);t.baseHash=d.baseHash;t.baseText=d.baseText;const companion=d.companions?.find(c=>c.path===layoutCompanionPath(doc.id));t.baseLayoutHash=companion?.baseHash??t.baseLayoutHash;t.assets=(d.assets??[]).map(a=>({...a,baseHash:null}));for(const asset of t.assets.filter(a=>a.path.startsWith('assets/objects/'))){const bytes=Uint8Array.from(atob(asset.text!),c=>c.charCodeAt(0));draftMediaUrls.set(id+':'+asset.path,URL.createObjectURL(new Blob([bytes],{type:detectMedia(bytes).mime})));}t.canvas.replace(d.text,companion?.text?JSON.parse(companion.text):t.layout);}this.renderTree();}
  private async loadPresets(){this.users=await request<DocumentPreset[]>('/api/document-presets');}
  private allPresets(){return [...builtinDocumentPresets,...this.users].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned));}
  /** 从正文采集预设时，实例文字和图片均由用户显式选择，默认只取结构。 */
  private async capturePreset(){
    if(!this.current())return;
    if(this.snapshot&&isTransientProject(this.snapshot.project.id)&&transientProjects.get(this.snapshot.project.id)==='example'&&!await this.saveAs())return;
    const tab=this.current();if(!tab)return;
    const imagePaths=[...new Set([...tab.doc.text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>resolveDocumentLink(tab.doc.path,m[1])?.path).filter((p):p is string=>!!p&&p.startsWith('docs/assets/')))];
    const result=await appForm('保存为文档预设',`<label>预设名称<input name="name" value="${h(tab.doc.title)}" required maxlength="100"/></label><label><input type="checkbox" name="content"/>保留示范文字和字段值（默认仅保存结构）</label><fieldset><legend>明确纳入的图片附件</legend>${imagePaths.map(path=>`<label><input type="checkbox" name="asset" value="${h(path)}"/>${h(path)}</label>`).join('')||'<p>没有可纳入的图片附件。</p>'}</fieldset><p>其他外部引用成为占位。不复制凭证、历史或恢复草稿。</p>`,'保存预设',async data=>{
      const selected=new Set(data.getAll('asset').map(String)),assets:Record<string,string>={};
      for(const path of selected){const draft=tab.assets.find(a=>a.path===path);if(draft?.text){assets[path]=draft.text;continue;}const response=await fetch(projectAssetUrl(this.snapshot!,path));if(!response.ok)throw new Error('图片读取失败：'+path);const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>12*1024*1024)throw new Error('图片超过预设附件限制：'+path);let text='';for(const byte of bytes)text+=String.fromCharCode(byte);assets[path]=btoa(text);}
      const source=tab.doc.text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,(match,label,url)=>selected.has(resolveDocumentLink(tab.doc.path,url)?.path??'')?match:'待选择图片：'+label);
      const preset=captureDocumentPreset(source,String(data.get('name')),data.has('content'),tab.layout,selected.size>0);preset.assets=assets;
      return request<DocumentPreset[]>('/api/document-presets',{preset});
    });if(result){this.users=result;this.notice('已保存到我的文档预设，现有文档不会随预设改变。');}
  }

  async presetLibrary(){await this.loadPresets();const chosen=await pickDocumentPreset(this.allPresets(),true);if(!chosen)return;if(this.snapshot&&transientProjects.get(this.snapshot.project.id)==='example'&&!await this.saveAs())return;let preset=this.allPresets().find(p=>p.id===chosen.id)!;if(chosen.action==='delete'){if(preset.source!=='user')throw new Error('官方预设不能删除。');const ok=await appChoice('删除我的预设','已用此预设创建的文档会保留。',[{id:'keep',label:'保留'},{id:'delete',label:'删除预设'}]);if(ok==='delete')this.users=await request<DocumentPreset[]>('/api/document-presets',{remove:preset.id});return;}if(chosen.action==='pin'){if(preset.source==='builtin')preset={...preset,id:'user-'+crypto.randomUUID(),source:'user'};await request('/api/document-presets',{preset:{...preset,pinned:!preset.pinned}});return;}
    if(!this.snapshot){const snapshot=await (await import('../browser/transient-projects')).createTransient('文档预设编辑','preset');await this.open(snapshot);}
    if(chosen.action==='blank')preset={format:1,id:'user-'+crypto.randomUUID(),name:'新预设',description:'',tags:[],source:'user',markdown:'---\nid: preset-blank\ntype: dd\nstatus: draft\n---\n\n# 新预设\n\n在这里组合模块。\n'};
    else if(preset.source==='builtin'||chosen.action==='copy')preset={...structuredClone(preset),id:'user-'+crypto.randomUUID(),source:'user',name:preset.name+' · 我的预设'};
    this.show();const value=instantiateDocumentPreset(preset,preset.name),doc:ProjectDocument={id:value.id,path:`docs/dd/${value.id}.md`,title:preset.name,type:'dd',status:'draft',system:'',text:value.markdown,hash:''};this.canvases.querySelector('.document-empty')?.remove();const t=this.mountTab(doc,true,value.layout);t.preset=preset;t.dirty=true;this.active=doc.id;t.assets=Object.entries(value.assets).map(([path,text])=>({path,text,baseHash:null,encoding:'base64'}));this.renderTabs();t.canvas.refresh();this.renderProperties();
  }
  /** 保存正在编辑的预设时，把旧用途并入标签；不回写源项目或其他预设。 */
  private async savePreset(tab:DocumentTab){if(this.snapshot&&transientProjects.get(this.snapshot.project.id)==='example')throw new Error('请先将学习示例另存为正式项目，再保存个人预设。');const tags=documentPresetTags({...tab.preset!,markdown:tab.doc.text}),preset={...tab.preset!,assets:Object.fromEntries(tab.assets.filter(a=>a.text!==null).map(a=>[a.path,a.text!])),name:tab.doc.title,markdown:setMetadata(tab.doc.text,{tags,purpose:undefined}),layout:tab.layout,tags,updatedAt:new Date().toISOString()};delete preset.purpose;this.users=await request<DocumentPreset[]>('/api/document-presets',{preset});tab.preset=preset;tab.dirty=false;this.renderTabs();this.notice('文档预设已保存，现有文档未改变。');}
  async examples(){if(currentProjectLoading()||!await this.leave())return;const chosen=await pickLearningExample();if(!chosen)return;
    const loading=beginProjectLoading('学习示例');if(!loading)return;
    try{
      await loading.paint();loading.throwIfCancelled();
      const {createLearningExample}=await import('../browser/learning-examples');loading.throwIfCancelled();
      const exampleRead=createLearningExample(chosen).then(async snapshot=>{
        // 示例创建不支持中途终止；取消后清理迟到的内存会话，避免留下未打开的临时项目。
        if(loading.signal.aborted)(await import('../browser/transient-projects')).disposeTransient(snapshot.project.id);
        return snapshot;
      });
      const snapshot=await loading.wait(exampleRead);loading.throwIfCancelled();await this.open(snapshot,true,loading);
    }catch(error){if(!loading.signal.aborted)throw error;}
    finally{loading.finish();}
  }
  private async about(){await aboutDesignform();}
  private key(e:KeyboardEvent){
    if(e.isComposing||document.querySelector('dialog:modal')||this.questionKey(e))return;const input=(e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]'),action=shortcutAction(e);if(!action)return;
    const run=(promise:Promise<unknown>)=>void promise.catch(error=>this.report(error));
    if(action==='settings'){e.preventDefault();run(openInputSettings());return;}
    if(input&&['copy','cut','paste','selectAll','delete','undo','redo'].includes(action)){
      // 默认文字按键由浏览器处理；自定义的文字编辑键通过桌面命令回到原输入控件。
      const defaults={copy:'Ctrl+C',cut:'Ctrl+X',paste:'Ctrl+V',selectAll:'Ctrl+A',delete:'Delete',undo:'Ctrl+Z',redo:'Ctrl+Y'};
      if(window.cewenDesktop&&action!=='delete'&&shortcutLabel(action as keyof typeof defaults)!==defaults[action as keyof typeof defaults]){e.preventDefault();desktopCommand(action as 'copy'|'cut'|'paste'|'selectAll'|'undo'|'redo');}return;
    }
    const tasks:Partial<Record<typeof action,()=>unknown>>={open:()=>run(this.showLibrary().then(()=>this.libraryHost.querySelector<HTMLButtonElement>('[data-open]')?.click())),save:()=>run(this.save()),saveAll:()=>run(this.save(true)),saveAs:()=>run(this.saveAs()),close:()=>run(this.closeTab(this.active)),newDocument:()=>run(this.home?this.newProject():this.newDocument()),newProject:()=>run(this.newProject()),rename:()=>!input&&run(this.rename([...this.selected][0]??this.active)),link:()=>this.current()&&run(this.insertReference(this.current()!)),undo:()=>!this.isDocumentLocked()&&this.current()?.canvas.undo(),redo:()=>!this.isDocumentLocked()&&this.current()?.canvas.redo(),findDirectory:()=>this.tree.parentElement!.querySelector<HTMLInputElement>('[type=search]')?.focus(),find:()=>run(appForm('查找当前文档','<label>文字<input name="query" required/></label>','定位',data=>{if(!this.current()?.canvas.find(String(data.get('query'))))throw new Error('当前文档中没有找到这段文字。');return true;})),delete:()=>run(this.tree.contains(e.target as Node)?this.deleteDocuments():this.current()?.canvas.clipboard('delete')??Promise.resolve())};
    if(['copy','cut','paste','selectAll'].includes(action)){e.preventDefault();run(this.current()?.canvas.clipboard(action as 'copy'|'cut'|'paste'|'selectAll')??Promise.resolve());return;}
    if(tasks[action]){e.preventDefault();e.stopPropagation();tasks[action]!();}
  }
}
