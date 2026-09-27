import type { ProjectInfo,ProjectSnapshot } from '../shared/model';
import { listProjects,readProject,openProject,projectAction } from './project-client';
import { h } from './creative/render';
import { appForm,appChoice } from './app-dialog';
import { showAppMenu } from './app-menu';
import { isWebEdition,prepareDirectoryFields } from './edition';
import { APP_VERSION } from '../shared/version';

/** 项目库只读入口和时间，不为显示列表打开项目或创建示例。 */
export class ProjectLibraryView {
  private projects:ProjectInfo[]=[];private page=0;private size=6;private query='';private favoriteOnly=false;private sort='updated';private favorites=new Set<string>();
  private resize:ResizeObserver;
  constructor(private host:HTMLElement,private onOpen:(snapshot:ProjectSnapshot)=>Promise<void>|void,private onNew:()=>void,private onExamples:()=>void){
    try{this.favorites=new Set(JSON.parse(localStorage.getItem('cewen-library-favorites')??'[]'));this.sort=localStorage.getItem('cewen-library-sort')??'updated';}catch{/* 个人偏好损坏时使用默认值。 */}
    this.resize=new ResizeObserver(()=>{const size=Math.max(1,Math.floor(Math.max(150,this.host.clientHeight-235)/126))*Math.max(1,Math.floor(Math.max(260,this.host.clientWidth-80)/340));if(size!==this.size){this.size=size;this.render();}});this.resize.observe(host);
  }
  async refresh(){this.projects=(await listProjects()).projects;this.render();}
  dispose(){this.resize.disconnect();}
  private favorite(id:string){this.favorites.has(id)?this.favorites.delete(id):this.favorites.add(id);localStorage.setItem('cewen-library-favorites',JSON.stringify([...this.favorites]));this.render();}
  private async delete(project:ProjectInfo){
    const first=await appChoice('删除本地项目',`${project.name}\n${project.path}\n${isWebEdition?'浏览器将永久删除这个目录及其文档、媒体和历史。':'这个目录及其文档、媒体和历史将移入 Windows 回收站。'}`,[{id:'cancel',label:'保留项目'},{id:'delete',label:'继续删除'}]);if(first!=='delete')return;
    const removed=await appForm('再次确认删除',`<p>即将删除：<strong>${h(project.name)}</strong></p><code>${h(project.path)}</code><label>请输入完整项目名称<input name="name" required autocomplete="off"/></label>`,'确认删除',async data=>{if(data.get('name')!==project.name)throw new Error('名称不一致，未删除文件。');await projectAction(project.id,'delete',{path:project.path,name:project.name});return true;});if(removed)await this.refresh();
  }
  private menu(project:ProjectInfo,anchor:HTMLElement,event?:MouseEvent){showAppMenu([
    {label:'打开项目',run:()=>readProject(project.id).then(this.onOpen)},
    {label:this.favorites.has(project.id)?'取消收藏':'收藏项目',run:()=>this.favorite(project.id)},
    {label:'从项目库移除入口',run:async()=>{const result=await appChoice('移除项目入口','项目文件会保留在原位置。',[{id:'keep',label:'保留入口'},{id:'forget',label:'移除入口'}]);if(result==='forget'){await projectAction(project.id,'forget',{});await this.refresh();}}},
    {label:'删除本地项目…',danger:true,separator:true,run:()=>this.delete(project)},
  ],anchor,event?{x:event.clientX,y:event.clientY}:undefined);}
  private render(){
    const items=this.projects.filter(p=>(!this.favoriteOnly||this.favorites.has(p.id))&&`${p.name} ${p.description}`.toLowerCase().includes(this.query.toLowerCase())).sort((a,b)=>this.sort==='name'?a.name.localeCompare(b.name,'zh-CN'):((this.sort==='created'?b.createdAt:b.updatedAt)??'').localeCompare((this.sort==='created'?a.createdAt:a.updatedAt)??'')||a.name.localeCompare(b.name,'zh-CN'));
    const pages=Math.max(1,Math.ceil(items.length/this.size));this.page=Math.min(this.page,pages-1);
    const date=(v?:string)=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未知（旧项目未记录）';
    this.host.innerHTML=`<header class="library-heading"><div><small>策问 Designform · ${APP_VERSION}</small><h1>项目库</h1><p>继续创作，或从一个新设想开始。</p></div><div><button data-examples>示例与新手教程</button><button data-open>打开本地项目</button><button data-new class="primary-button">＋ 新建项目</button></div></header><div class="library-controls"><button data-all aria-pressed="${!this.favoriteOnly}">全部项目</button><button data-favorites aria-pressed="${this.favoriteOnly}">收藏夹</button><input type="search" aria-label="搜索项目" placeholder="搜索项目" value="${h(this.query)}"/><label>排序 <select aria-label="项目排序"><option value="updated">最后编辑时间</option><option value="created">创建时间</option><option value="name">名称</option></select></label></div><div class="library-projects">${items.slice(this.page*this.size,(this.page+1)*this.size).map(p=>`<article class="library-project" data-id="${h(p.id)}"><button data-enter data-project-path="${h(p.path)}"><h2>${this.favorites.has(p.id)?'★ ':''}${h(p.name)}</h2><p>${h(p.description||p.path)}</p><small>最后编辑 ${h(date(p.updatedAt))}</small><small>创建时间 ${h(date(p.createdAt))}</small></button><button data-more aria-label="${h(p.name)}的项目选项">⋯</button></article>`).join('')||'<section class="library-empty"><h2>从一份文档开始</h2><p>新建项目，或者打开已有项目目录。学习示例不会创建本地项目。</p></section>'}</div><footer class="library-pagination"><span>${items.length} 个项目</span><button data-prev ${this.page===0?'disabled':''}>上一页</button><span>第 ${this.page+1} / ${pages} 页</span><button data-next ${this.page+1>=pages?'disabled':''}>下一页</button><span role="status"></span></footer>`;
    const run=(work:Promise<unknown>)=>void work.catch(error=>{this.host.querySelector('[role=status]')!.textContent=error.message;});
    this.host.querySelector<HTMLSelectElement>('select')!.value=this.sort;
    this.host.querySelector('select')!.onchange=e=>{this.sort=(e.target as HTMLSelectElement).value;localStorage.setItem('cewen-library-sort',this.sort);this.page=0;this.render();};
    this.host.querySelector<HTMLInputElement>('[type=search]')!.oninput=e=>{const input=e.target as HTMLInputElement,start=input.selectionStart;this.query=input.value;this.page=0;this.render();const next=this.host.querySelector<HTMLInputElement>('[type=search]')!;next.focus();if(start!==null)try{next.setSelectionRange(start,start);}catch{}};
    this.host.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b)return;const p=this.projects.find(p=>p.id===b.closest<HTMLElement>('[data-id]')?.dataset.id);if(b.hasAttribute('data-enter')&&p)run(readProject(p.id).then(this.onOpen));if(b.hasAttribute('data-more')&&p)this.menu(p,b);if(b.hasAttribute('data-new'))this.onNew();if(b.hasAttribute('data-examples'))this.onExamples();if(b.hasAttribute('data-open'))run(appForm('打开本地项目','<label>项目根目录<input name="directory" required/></label>','打开',data=>openProject(String(data.get('directory')))).then(next=>{if(next)return this.onOpen(next);}));if(b.hasAttribute('data-all')){this.favoriteOnly=false;this.page=0;this.render();}if(b.hasAttribute('data-favorites')){this.favoriteOnly=true;this.page=0;this.render();}if(b.hasAttribute('data-prev')){this.page--;this.render();}if(b.hasAttribute('data-next')){this.page++;this.render();}};
    this.host.oncontextmenu=e=>{const card=(e.target as HTMLElement).closest<HTMLElement>('[data-id]'),p=this.projects.find(p=>p.id===card?.dataset.id);if(card&&p){e.preventDefault();this.menu(p,card,e);}};prepareDirectoryFields(this.host);
  }
}
