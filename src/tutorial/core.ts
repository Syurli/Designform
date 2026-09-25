import type { TutorialAdapter,TutorialDefinition,TutorialProgress,TutorialStore,TutorialControls,TutorialStatus } from './types';
/** 编排、恢复与状态机独立于展示层。按稳定步骤 ID 记录，跳过不会计为完成。 */
export class TutorialCore {
 private current?:TutorialDefinition;private index=0;private adapter?:TutorialAdapter;private pending?:AbortController;private run=0;private checking=false;
 constructor(private definitions:TutorialDefinition[],private adapters:TutorialAdapter[],private store:TutorialStore,private announce?:(text:string)=>void){for(const d of definitions){if(new Set(d.steps.map(s=>s.id)).size!==d.steps.length)throw new Error(`教程 ${d.id} 存在重复步骤身份`);}}
 available(){return this.definitions.map(({id,title,version,steps,practice})=>({id,title,version,practice,steps:steps.length,progress:this.store.read()[id]}));}
 isActive(){return !!this.current;}
 shouldAutoStart(id:string){const t=this.definitions.find(t=>t.id===id);return !!t&&!this.store.read()[id];}
 reset(id?:string){if(!id||this.current?.id===id)this.pause();const values=this.store.read();if(id)delete values[id];else for(const key of Object.keys(values))delete values[key];this.store.write(values);}
 async start(id:string,from?:number){this.pause();const t=this.definitions.find(t=>t.id===id);if(!t?.steps.length)return;this.current=t;const saved=this.store.read()[id];const resume=saved?.version===t.version&&['running','paused'].includes(saved.status);const stable=saved?.stepId?t.steps.findIndex(s=>s.id===saved.stepId):-1;this.index=from??(resume?(stable>=0?stable:saved.step):0);if(!resume||from===0)this.store.write({...this.store.read(),[id]:{version:t.version,status:'running',step:0,completed:[],skipped:[],updatedAt:new Date().toISOString()}});this.index=Math.max(0,Math.min(this.index,t.steps.length-1));await this.show();}
 private progress():TutorialProgress {const t=this.current!,p=this.store.read()[t.id];return p?.version===t.version?{...p,completed:[...(p.completed??[])],skipped:[...(p.skipped??[])]}:{version:t.version,status:'running',step:this.index,completed:[],skipped:[],updatedAt:new Date().toISOString()};}
 private record(status:TutorialStatus,mark?:'completed'|'skipped'){if(!this.current)return;const p=this.progress();p.status=status;p.step=this.index;p.stepId=this.current.steps[this.index].id;p.updatedAt=new Date().toISOString();if(mark){const id=this.current.steps[this.index].id;p[mark]=[...new Set([...p[mark],id])];p[mark==='completed'?'skipped':'completed']=p[mark==='completed'?'skipped':'completed'].filter(x=>x!==id);}this.store.write({...this.store.read(),[this.current.id]:p});}
 private controls:TutorialControls={next:()=>this.next(false),previous:()=>{if(this.index>0){this.index--;void this.show();}},skipStep:()=>this.next(true),skipAll:()=>this.finish('skipped'),pause:()=>this.pause(),fastForward:()=>this.fastForward()};
 private async show(){if(!this.current)return;this.pending?.abort();this.adapter?.clear();this.adapter=undefined;const signal=(this.pending=new AbortController()).signal,run=++this.run,t=this.current,step=t.steps[this.index];this.record('running');
  try {await step.before?.(signal);if(signal.aborted||run!==this.run)return;const adapter=this.adapters.find(a=>a.canHandle(step.target));if(!adapter)throw new Error('没有支持此目标的教程适配器');this.adapter=adapter;await adapter.show({definition:t,step,index:this.index,controls:this.controls,signal});if(!signal.aborted)this.announce?.(`${t.title}：${this.index+1}/${t.steps.length}，可暂停或跳过。`);}
  catch(error){if(signal.aborted)return;this.announce?.(`教程已暂停：${(error as Error).message}`);this.pause();}
 }
 private next(skip:boolean){void this.advance(skip);}
 private async advance(skip:boolean){if(!this.current||this.checking&&!skip)return;const run=this.run,step=this.current.steps[this.index];
  if(!skip&&step.check){this.checking=true;try{const result=await step.check(this.pending!.signal);if(run!==this.run||!this.current)return;if(result!==true){const message=typeof result==='string'?result:'请完成本步操作，或明确跳过。';this.adapter?.feedback?.(message);this.announce?.(message);return;}}catch(error){if(run===this.run)this.adapter?.feedback?.((error as Error).message);return;}finally{this.checking=false;}}
  if(!this.current||run!==this.run)return;this.record('running',skip?'skipped':'completed');if(this.index===this.current.steps.length-1){const p=this.progress();this.finish(p.completed.length===this.current.steps.length?'completed':'partial');return;}this.index++;await this.show();
 }
 private fastForward(){if(!this.current)return;const currentChapter=this.current.steps[this.index].chapter;let next=this.current.steps.findIndex((s,i)=>i>this.index&&s.chapter!==currentChapter);if(next<0)next=this.current.steps.length-1;for(let i=this.index;i<next;i++){this.index=i;this.record('running','skipped');}this.index=next;void this.show();}
 pause(){if(!this.current)return;this.finish('paused');}
 private finish(status:TutorialStatus){if(!this.current)return;const title=this.current.title;this.record(status);this.current=undefined;this.run++;this.pending?.abort();this.pending=undefined;this.adapter?.clear();this.adapter=undefined;this.announce?.(`${title}：${({completed:'已完成',paused:'已暂停，可从教程中心继续',skipped:'已跳过，可重新开始',partial:'已结束，部分步骤跳过',running:'进行中'})[status]}`);}
 dispose(){this.pause();}
}
