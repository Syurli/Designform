import type { ProjectInfo,ProjectSnapshot } from '../shared/model';
import { listProjects,readProject,openProject,projectAction } from './project-client';
import { h } from './creative/render';
import { appForm,appChoice } from './app-dialog';
import { showAppMenu } from './app-menu';
import { isWebEdition,prepareDirectoryFields } from './edition';
import { openInputSettings } from './input-settings';
import { aboutDesignform } from './about';
import { browse,canBrowse } from './browse-history';
import { APP_VERSION } from '../shared/version';
import { beginProjectLoading, currentProjectLoading, type ProjectLoadingTask } from './project-loading';

/** 项目库只读入口和时间，不为显示列表打开项目或创建示例。 */
export class ProjectLibraryView {
  private projects:ProjectInfo[]=[];private page=0;private size=6;private query='';private favoriteOnly=false;private sort='updated';private favorites=new Set<string>();
  private resize:ResizeObserver;
  private opening?:ProjectLoadingTask;
  constructor(private host:HTMLElement,private onOpen:(snapshot:ProjectSnapshot,loading?:ProjectLoadingTask)=>Promise<void>|void,private onNew:()=>Promise<void>|void,private onExamples:()=>Promise<void>|void,private session?:()=>{name:string;dirty:boolean;resume:()=>void}|undefined,private beforeDelete?:(id:string)=>Promise<boolean>,private onDeleted?:(id:string)=>void){
    try{this.favorites=new Set(JSON.parse(localStorage.getItem('cewen-library-favorites')??'[]'));this.sort=localStorage.getItem('cewen-library-sort')??'updated';}catch{/* 个人偏好损坏时使用默认值。 */}
    this.resize=new ResizeObserver(()=>{const size=Math.max(1,Math.floor(Math.max(150,this.host.clientHeight-235)/126))*Math.max(1,Math.floor(Math.max(260,this.host.clientWidth-80)/340));if(size!==this.size){this.size=size;this.render();}});this.resize.observe(host);
    window.addEventListener('cewen:project-loading-change', this.loadingChanged);
  }
  async refresh(){this.projects=(await listProjects()).projects;this.render();}
  dispose(){this.resize.disconnect();window.removeEventListener('cewen:project-loading-change', this.loadingChanged);this.opening?.cancel();}
  /** 任务锁与按钮状态共用当前载入任务，重绘项目库也不会恢复重复点击入口。 */
  private loadingChanged=()=>{
    const busy=Boolean(currentProjectLoading());this.host.classList.toggle('project-library-loading',busy);this.host.setAttribute('aria-busy',String(busy));
    this.host.querySelectorAll<HTMLButtonElement>('[data-enter],[data-open],[data-new],[data-examples],[data-more]').forEach(button=>button.disabled=busy);
  };
  /** 所有项目库打开入口共用读取、取消及错误清理；异步结果返回前不展示虚构百分比。 */
  private async loadAndOpen(read:()=>Promise<ProjectSnapshot>,name:string):Promise<ProjectSnapshot|undefined>{
    const loading=beginProjectLoading(name);if(!loading)return;
    this.opening=loading;
    try{
      await loading.paint();loading.throwIfCancelled();
      const snapshot=await loading.wait(read());loading.throwIfCancelled();loading.setTitle(snapshot.project.name);
      // 文件已读取完成，接下来由工作台按真实渲染步骤继续报告分类、内容和界面阶段。
      loading.setCancellable(false);loading.stage('categories',`${snapshot.groups.length} 个分类 · ${snapshot.documents.length} 份文档`);await loading.paint();
      await this.onOpen(snapshot,loading);return snapshot;
    }catch(error){if(loading.signal.aborted)return;throw error;}
    finally{loading.finish();if(this.opening===loading)this.opening=undefined;this.loadingChanged();}
  }
  private favorite(id:string){this.favorites.has(id)?this.favorites.delete(id):this.favorites.add(id);localStorage.setItem('cewen-library-favorites',JSON.stringify([...this.favorites]));this.render();}
  private async delete(project:ProjectInfo){
    // 一次确认即可删除；显示名称、路径和删除后果，不再要求手工输入名称。
    const removed=await appForm('删除本地项目',`<p>即将删除：<strong>${h(project.name)}</strong></p><code>${h(project.path)}</code><p>${isWebEdition?'浏览器将永久删除这个目录及其文档、媒体和历史。':'这个目录及其文档、媒体和历史将移入 Windows 回收站。'}</p>`,'确认删除',async()=>{if(this.beforeDelete&&!await this.beforeDelete(project.id))return false;await projectAction(project.id,'delete',{path:project.path,name:project.name});return true;});if(removed){this.onDeleted?.(project.id);await this.refresh();}
  }
  private menu(project:ProjectInfo,anchor:HTMLElement,event?:MouseEvent){showAppMenu([
    {label:'打开项目',disabled:Boolean(currentProjectLoading()),run:()=>this.loadAndOpen(()=>readProject(project.id),project.name)},
    {label:this.favorites.has(project.id)?'取消收藏':'收藏项目',run:()=>this.favorite(project.id)},
    {label:'从项目库移除入口',run:async()=>{const result=await appChoice('移除项目入口','项目文件会保留在原位置。',[{id:'keep',label:'保留入口'},{id:'forget',label:'移除入口'}]);if(result==='forget'){if(this.beforeDelete&&!await this.beforeDelete(project.id))return;await projectAction(project.id,'forget',{});this.onDeleted?.(project.id);await this.refresh();}}},
    {label:'删除本地项目…',danger:true,separator:true,run:()=>this.delete(project)},
  ],anchor,event?{x:event.clientX,y:event.clientY}:undefined);}
  private render(){
    const items=this.projects.filter(p=>(!this.favoriteOnly||this.favorites.has(p.id))&&`${p.name} ${p.description}`.toLowerCase().includes(this.query.toLowerCase())).sort((a,b)=>this.sort==='name'?a.name.localeCompare(b.name,'zh-CN'):((this.sort==='created'?b.createdAt:b.updatedAt)??'').localeCompare((this.sort==='created'?a.createdAt:a.updatedAt)??'')||a.name.localeCompare(b.name,'zh-CN'));
    const pages=Math.max(1,Math.ceil(items.length/this.size));this.page=Math.min(this.page,pages-1);
    const date=(v?:string)=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未知（旧项目未记录）';
    const session=this.session?.();
    this.host.innerHTML=`<header class="library-heading"><div><small>策问 Designform · ${APP_VERSION}</small><h1>项目库</h1>${session?`<button data-resume>← 返回《${h(session.name)}》${session.dirty?' · 有未保存修改':''}</button>`:''}<p>继续创作，或从一个新设想开始。</p></div><div><button data-library-back aria-label="浏览上一页" ${canBrowse('back')?'':'disabled'}>←</button><button data-library-forward aria-label="浏览下一页" ${canBrowse('forward')?'':'disabled'}>→</button><button data-library-settings>设置</button><button data-library-about>关于</button><button data-examples>示例与新手教程</button><button data-open>打开本地项目</button><button data-new class="primary-button">＋ 新建项目</button></div></header><div class="library-controls"><button data-all aria-pressed="${!this.favoriteOnly}">全部项目</button><button data-favorites aria-pressed="${this.favoriteOnly}">收藏夹</button><input type="search" aria-label="搜索项目" placeholder="搜索项目" value="${h(this.query)}"/><label>排序 <select aria-label="项目排序"><option value="updated">最后编辑时间</option><option value="created">创建时间</option><option value="name">名称</option></select></label></div><div class="library-projects">${items.slice(this.page*this.size,(this.page+1)*this.size).map(p=>`<article class="library-project" data-id="${h(p.id)}"><button data-enter data-project-path="${h(p.path)}"><h2>${this.favorites.has(p.id)?'★ ':''}${h(p.name)}</h2><p>${h(p.description||p.path)}</p><small>最后编辑 ${h(date(p.updatedAt))}</small><small>创建时间 ${h(date(p.createdAt))}</small></button><button data-more aria-label="${h(p.name)}的项目选项">⋯</button></article>`).join('')||'<section class="library-empty"><h2>从一份文档开始</h2><p>新建项目，或者打开已有项目目录。学习示例不会创建本地项目。</p></section>'}</div><footer class="library-pagination"><span>${items.length} 个项目</span><button data-prev ${this.page===0?'disabled':''}>上一页</button><span>第 ${this.page+1} / ${pages} 页</span><button data-next ${this.page+1>=pages?'disabled':''}>下一页</button><span role="status"></span></footer>`;
    const run=(work:Promise<unknown>)=>void work.catch(error=>{const status=this.host.querySelector('[role=status]');if(status)status.textContent=error.message??String(error);});
    this.host.querySelector<HTMLSelectElement>('select')!.value=this.sort;
    this.host.querySelector('select')!.onchange=e=>{this.sort=(e.target as HTMLSelectElement).value;localStorage.setItem('cewen-library-sort',this.sort);this.page=0;this.render();};
    this.host.querySelector<HTMLInputElement>('[type=search]')!.oninput=e=>{const input=e.target as HTMLInputElement,start=input.selectionStart;this.query=input.value;this.page=0;this.render();const next=this.host.querySelector<HTMLInputElement>('[type=search]')!;next.focus();if(start!==null)try{next.setSelectionRange(start,start);}catch{}};
    this.host.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b||b.disabled)return;if(currentProjectLoading()&&b.matches('[data-enter],[data-open],[data-new],[data-examples],[data-more]'))return;if(b.hasAttribute('data-resume')){this.session?.()?.resume();return;}if(b.hasAttribute('data-library-back')){browse('back');return;}if(b.hasAttribute('data-library-forward')){browse('forward');return;}if(b.hasAttribute('data-library-settings')){run(openInputSettings());return;}if(b.hasAttribute('data-library-about')){run(aboutDesignform());return;}const p=this.projects.find(p=>p.id===b.closest<HTMLElement>('[data-id]')?.dataset.id);if(b.hasAttribute('data-enter')&&p)run(this.loadAndOpen(()=>readProject(p.id),p.name));if(b.hasAttribute('data-more')&&p)this.menu(p,b);if(b.hasAttribute('data-new')){const status=this.host.querySelector('[role=status]');if(status)status.textContent='正在准备新建项目…';run(Promise.resolve().then(()=>this.onNew()).then(()=>{if(status?.isConnected)status.textContent='';}));}if(b.hasAttribute('data-examples'))run(Promise.resolve().then(()=>this.onExamples()));if(b.hasAttribute('data-open'))run(appForm('打开本地项目','<label>项目根目录<input name="directory" required/></label>','打开',data=>{const path=String(data.get('directory')).trim();return this.loadAndOpen(()=>openProject(path),path.split(/[\\/]/).filter(Boolean).at(-1)??'本地项目');}));if(b.hasAttribute('data-all')){this.favoriteOnly=false;this.page=0;this.render();}if(b.hasAttribute('data-favorites')){this.favoriteOnly=true;this.page=0;this.render();}if(b.hasAttribute('data-prev')){this.page--;this.render();}if(b.hasAttribute('data-next')){this.page++;this.render();}};
    this.host.oncontextmenu=e=>{const card=(e.target as HTMLElement).closest<HTMLElement>('[data-id]'),p=this.projects.find(p=>p.id===card?.dataset.id);if(card&&p){e.preventDefault();if(!currentProjectLoading())this.menu(p,card,e);}};prepareDirectoryFields(this.host);this.loadingChanged();
  }
}
