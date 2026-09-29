import type { ProjectSnapshot } from '../shared/model';
import type { CollaborationState, WorkDocumentProjection, WorkTaskSummary } from '../shared/collaboration';
import { request } from './project-client';
import { escapeHtml as html } from './markdown-view';
import './collaboration-live.css';
/** 任务面板只发送用户控制指令，绝不提供绕过工作锁的本地解锁。 */
export class CollaborationLive {
  private host=document.createElement('section');
  private busy=false;
  constructor(private snapshot:()=>ProjectSnapshot|undefined,private refresh:()=>Promise<void>){
    this.host.className='collaboration-live';
    this.host.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
      if(button.dataset.workDocument){window.dispatchEvent(new CustomEvent('cewen:read-document',{detail:button.dataset.workDocument}));return;}
      if(button.dataset.workDraft){void this.viewDraft(button.dataset.workDraft);return;}
      if(button.dataset.workAction&&button.dataset.workTask)void this.control(button.dataset.workTask,button.dataset.workAction);
    });
  }
  mount(parent:Element){parent.append(this.host);this.render();}
  render(){const snapshot=this.snapshot(),tasks=snapshot?.collaboration?.tasks??[];
    const labels={running:'正在编写',completed:'已完成',interrupted:'已中断',failed:'失败',cancelled:'已停止'};
    this.host.innerHTML='<h2>当前项目任务</h2>'+(!snapshot?'<p>请选择项目。</p>':!tasks.length?'<p>尚无协作任务。</p>': [...tasks].sort((a,b)=>Number(['failed','interrupted'].includes(b.status))-Number(['failed','interrupted'].includes(a.status))).map(task=>'<article><strong>'+html(task.title)+'</strong><span>'+labels[task.status]+'</span>'+(task.error?'<p role="status">'+html(task.error)+'</p>':'')+'<div>'+task.documentIds.map(id=>'<button data-work-document="'+html(id)+'">'+html(snapshot.documents.find(d=>d.id===id)?.title??snapshot.collaboration?.documents.find(d=>d.id===id)?.title??id)+'</button>').join('')+'</div><div>'+ (task.status==='running'?this.button(task.id,'cancel','停止'):task.status==='completed'?(task.revision?this.button(task.id,'undo','撤销本次任务'):'<span class="quiet">已完成，未产生正式变更</span>'):this.button(task.id,'resume','恢复')+this.button(task.id,'dismiss','清除异常提示')+'<button data-work-draft="'+html(task.id)+'">查看保留工作稿</button>')+'</div></article>').join(''));
    this.host.querySelectorAll<HTMLButtonElement>('[data-work-action]').forEach(button=>button.disabled=this.busy);
  }
  /** 保留工作稿独立读取，只读展示，不能成为人工编辑器的保存基准。 */
  private async viewDraft(taskId:string){const projectId=this.snapshot()?.project.id;if(!projectId)return;const dialog=document.createElement('dialog');dialog.className='project-dialog';const title=document.createElement('h2'),body=document.createElement('section'),close=document.createElement('button');title.textContent='保留的 LLM 工作稿';body.textContent='正在读取…';close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(title,body,close);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();try{const result=await request<WorkTaskSummary&{documents:WorkDocumentProjection[]}>('/api/projects/'+encodeURIComponent(projectId)+'/work-status?taskId='+encodeURIComponent(taskId)+'&includeDrafts=1');if(!dialog.open)return;title.textContent=result.title??'保留的 LLM 工作稿';body.replaceChildren();const note=document.createElement('p');note.textContent='只读恢复资料 · 尚未形成正式版本';body.append(note);for(const doc of result.documents){const heading=document.createElement('h3'),text=document.createElement('textarea');heading.textContent=doc.title;text.readOnly=true;text.value=doc.text;text.rows=12;text.style.width='100%';text.setAttribute('aria-label',doc.title+'保留工作稿');body.append(heading,text);}if(!result.documents.length){const empty=document.createElement('p');empty.textContent='此任务没有保留的工作稿。';body.append(empty);}}catch(error){body.textContent=error instanceof Error?error.message:'未能读取保留工作稿';}}
  private button(id:string,action:string,label:string){return '<button data-work-task="'+html(id)+'" data-work-action="'+action+'">'+label+'</button>';}
  private async control(taskId:string,action:string){const id=this.snapshot()?.project.id;if(!id||this.busy)return;this.busy=true;this.render();
    try{await request('/api/projects/'+id+'/work-control',{taskId,action});await this.refresh();}
    catch(error){const note=document.createElement('p');note.role='alert';note.textContent=error instanceof Error?error.message:'任务操作未完成';this.host.append(note);}
    finally{this.busy=false;this.host.querySelectorAll<HTMLButtonElement>('[data-work-action]').forEach(button=>button.disabled=false);}
  }
}
/** 异常优先显示，同时保留真实并发数；心跳仅决定空闲连接灯。 */
export function collaborationSummary(work:CollaborationState|undefined,connected:boolean){
  const tasks=work?.tasks??[],running=tasks.filter(task=>task.status==='running').length;
  const abnormal=tasks.some(task=>task.status==='failed'||task.status==='interrupted');
  return {state:abnormal?'failed':running?'running':tasks.some(task=>task.status==='completed')?'completed':connected?'idle':'disconnected',label:(abnormal?'任务异常':running?'正在编写':tasks.some(task=>task.status==='completed')?'任务已完成':connected?'已连接 · 空闲':'未连接 LLM')+(running?' · '+running+' 个并发任务':'')};
}
