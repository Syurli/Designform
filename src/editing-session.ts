import { parseKnowledge } from '../shared/markdown';
import type { FileChange, ProjectSnapshot } from '../shared/model';
import { cacheDraft, ClientError, commitProject, deleteDraft, interceptUserCommits, projectDrafts, saveDraft, type UiCommitRequest } from './project-client';
import { graphChanges, type GraphEdit } from '../shared/graph-editing';

/** 一次手势的数据与布局一起撤销；布局是私有快照，不提交进公开版本。 */
type Step={before:FileChange[];after:FileChange[];undoLayout?:()=>void;redoLayout?:()=>void;label:string};
export class EditingSession {
  private base?:ProjectSnapshot;
  private pending=new Map<string,FileChange>();
  private past:Step[]=[];
  private future:Step[]=[];
  private draftId:string=crypto.randomUUID();
  private writes:Promise<unknown>=Promise.resolve();
  private recoveryId?:string;
  private projectEpoch=0;
  busy=false;
  constructor(private publish:(snapshot:ProjectSnapshot)=>void,private status:(text:string)=>void){
    interceptUserCommits((request,send)=>this.commit(request,send));
    window.addEventListener('beforeunload',event=>{if(this.pending.size){event.preventDefault();event.returnValue='';}});
  }
  get count(){return this.pending.size;}
  get canUndo(){return this.past.length>0;}
  get canRedo(){return this.future.length>0;}
  /** 磁盘更新只替换读取基准；已有修改继续携带旧哈希，发生冲突时由服务拒绝覆盖。 */
  receive(snapshot:ProjectSnapshot){
    if(this.base?.project.id!==snapshot.project.id){this.projectEpoch++;this.pending.clear();this.past=[];this.future=[];this.draftId=crypto.randomUUID();this.recoveryId=undefined;}
    this.base=snapshot;
    return this.snapshot();
  }
  snapshot():ProjectSnapshot {
    const base=this.base!;if(!base||base.historical||!this.pending.size)return base;
    const files=new Map(base.documents.map(doc=>[doc.path,{path:doc.path,text:doc.text,hash:doc.hash}]));
    if(base.projectEntry)files.set('PROJECT.md',{path:'PROJECT.md',...base.projectEntry});
    for(const change of this.pending.values())if(change.text!==null&&change.encoding!=='base64')files.set(change.path,{path:change.path,text:change.text,hash:change.baseHash??''});else if(change.text===null)files.delete(change.path);
    return {...base,...parseKnowledge([...files.values()])};
  }
  apply(edit:GraphEdit,undoLayout?:()=>void,redoLayout?:()=>void){
    if(this.busy)throw new Error('正在保存，请稍后操作。');
    const result=graphChanges(this.snapshot(),edit),before=[...this.pending.values()].map(item=>({...item}));
    // 无文件变化的同归属、原端点操作不进入撤销栈；真实布局变化仍可单独撤销。
    if(!result.changes.length){if(undoLayout&&redoLayout)this.layout(undoLayout,redoLayout);return;}
    for(const change of result.changes){const original=this.pending.get(change.path);this.pending.set(change.path,{...change,baseHash:original?original.baseHash:change.baseHash});}
    this.trim();this.past.push({before,after:[...this.pending.values()].map(item=>({...item})),undoLayout,redoLayout,label:result.label});this.future=[];
    this.changed(`${result.label} · ${this.count} 份文档待保存`);
  }
  /** 布局操作也加入当前画布撤销栈，正文的输入撤销由编辑器处理。 */
  layout(undoLayout:()=>void,redoLayout:()=>void){if(this.busy)return;const values=[...this.pending.values()];this.past.push({before:values,after:values,undoLayout,redoLayout,label:'调整布局'});this.future=[];this.status('布局已调整，可撤销');}
  undo(){if(this.busy)return;const step=this.past.pop();if(!step)return;this.future.push(step);this.pending=new Map(step.before.map(item=>[item.path,item]));this.changed(`已撤销：${step.label}`);step.undoLayout?.();}
  redo(){if(this.busy)return;const step=this.future.pop();if(!step)return;this.past.push(step);this.pending=new Map(step.after.map(item=>[item.path,item]));this.changed(`已重做：${step.label}`);step.redoLayout?.();}
  private trim(){for(const [path,change] of this.pending){const doc=this.base?.documents.find(item=>item.path===path);if(doc&&doc.hash===change.baseHash&&doc.text===change.text)this.pending.delete(path);}}
  private changed(message:string){if(this.past.length>80)this.past.shift();this.persist();this.publish(this.snapshot());this.status(message);}
  private persist(){
    if(!this.base)return;const projectId=this.base.project.id,id=this.draftId;
    if(!this.pending.size){this.writes=this.writes.catch(()=>{}).then(()=>deleteDraft(projectId,id)).catch(()=>{});return;}
    const changes=[...this.pending.values()],draft={id,purpose:'graph' as const,documentPath:'docs/dd/graph-session.md',baseHash:null,baseText:null,text:JSON.stringify(changes),changes,baseRevision:this.base.revision,updatedAt:new Date().toISOString()};
    cacheDraft(projectId,draft);this.writes=this.writes.catch(()=>{}).then(()=>saveDraft(projectId,draft)).catch(error=>{this.status(`图谱草稿暂未写入文件：${error.message}，页面仍保留修改。`);});
  }
  async recover(){
    if(!this.base||this.base.historical||this.pending.size||this.busy)return;
    const projectId=this.base.project.id,epoch=this.projectEpoch,values=(await projectDrafts(projectId)).filter(item=>item.purpose==='graph'&&item.changes?.length);
    // 读取草稿期间可能切换项目或开始保存；旧响应不能覆盖新会话的待保存内容。
    if(this.projectEpoch!==epoch||this.base?.project.id!==projectId||this.base.historical||this.pending.size||this.busy||!values.length)return;
    const draft=values[0];
    if(!confirm(`发现未保存的结构编辑（${draft.changes!.length} 份文档），恢复继续编辑？`))return;
    if(this.projectEpoch!==epoch||this.base?.project.id!==projectId||this.pending.size||this.busy)return;
    if(draft.changes!.some(item=>!(item.path==='PROJECT.md'||/^docs\/[^\\]+\.md$/.test(item.path))||(item.text!==null&&typeof item.text!=='string')||item.encoding))throw new Error('图谱草稿格式异常，原文件已保留。');
    this.pending=new Map(draft.changes!.map(item=>[item.path,item]));this.past=[{before:[],after:[...this.pending.values()],label:'恢复的结构草稿'}];this.future=[];this.recoveryId=draft.id;this.draftId=draft.id;this.changed('已恢复结构草稿；保存前仍会核查磁盘改动。');
  }
  async save(){if(!this.base||!this.count)return;const projectId=this.base.project.id,epoch=this.projectEpoch;const snapshot=await commitProject({projectId,requestId:crypto.randomUUID(),baseRevision:this.base.revision,actor:'user',reason:`整理结构与关系（${this.count} 份文档）`,changes:[]});if(this.projectEpoch===epoch&&this.base?.project.id===projectId){this.publish(snapshot);this.status('结构与关系已保存为正式版本');}}
  private async commit(request:UiCommitRequest,send:(value:UiCommitRequest)=>Promise<ProjectSnapshot>){
    if(this.busy)throw new Error('另一次保存尚未完成。');
    if(!this.base||request.projectId!==this.base.project.id)return send(request);
    // 正文单独保存也占用同一串行窗口，避免保存途中产生以旧正文为基准的结构草稿。
    if(!this.pending.size){this.busy=true;try{return await send(request);}finally{this.busy=false;}}
    const projectId=request.projectId,epoch=this.projectEpoch,draftId=this.draftId,base=this.base,merged=new Map(this.pending);
    for(const change of request.changes){const old=merged.get(change.path);if(old){
      const hasEditingBase=Object.prototype.hasOwnProperty.call(request.editingBases??{},change.path);
      // 正文若从旧文本打开，或其他入口没有声明基准，不能静默覆盖未保存的结构修改。
      if(hasEditingBase?request.editingBases![change.path]!==old.text:change.text!==old.text)throw new ClientError({code:'FILE_CONFLICT',message:'正文与结构草稿修改了同一文件，请比较后再保存。',details:{path:change.path,currentText:old.text,currentHash:old.baseHash,source:'graph-draft'}});
      if(old.baseHash!==change.baseHash)throw new Error('当前正文与结构草稿的保存基准不同，请先比较两份草稿。');
    }merged.set(change.path,change);}
    this.busy=true;this.status('正在保存结构与正文，请稍候…');
    try {
      await this.writes;
      const result=await send({...request,changes:[...merged.values()]});
      if(this.projectEpoch===epoch&&this.base?.project.id===projectId){
        // 保存前内容必须取发起时的基准；等待写盘期间的轮询不能改写撤销目标。
        const inverse=[...merged.values()].filter(change=>!change.encoding).map(change=>({path:change.path,baseHash:result.files?.[change.path]??result.documents.find(doc=>doc.path===change.path)?.hash??null,text:base.documents.find(doc=>doc.path===change.path)?.text??(change.path==='PROJECT.md'?base.projectEntry?.text??null:null)}));
        this.base=result;this.pending.clear();this.past=[{before:inverse,after:[],label:'恢复本次保存前的内容'}];this.future=[];this.draftId=crypto.randomUUID();
      }
      // 正式提交已成功，清理旧草稿失败不把保存谎报为失败。
      try{await deleteDraft(projectId,draftId);}catch{if(this.projectEpoch===epoch)this.status('版本已保存，旧草稿清理未完成。');}
      return result;
    }finally{this.busy=false;}
  }
}
