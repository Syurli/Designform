import type { ProjectService } from '../projects.ts';
import type { CreativeService } from './service.ts';
import type { FileChange,ProjectSnapshot } from '../../shared/model.ts';
import { buildPreset,presets } from '../../shared/creative/presets.ts';
import { buildCreativeIndex,objectBlock } from '../../shared/creative/content.ts';
import { asString,asStrings,type CreativeObject } from '../../shared/creative/model.ts';
import { setMetadata } from '../../shared/editing.ts';
import { readHeader } from '../../shared/markdown.ts';
import { Buffer } from '../platform.ts';
import { ProjectError } from '../files.ts';
import { ProductionService } from './production-service.ts';
const key=(v:unknown)=>{const s=asString(v);if(!/^[A-Za-z0-9_-]{1,60}$/.test(s))throw new ProjectError('INVALID_PRESET_INSTANCE','预设实例身份无效');return s;};
/** 预设只追加内容。任何预设都不写 capability 限制，也不删除已有对象。 */
export class PresetService {
 constructor(private projects:ProjectService,private creative:CreativeService){}
 preview(input:Record<string,unknown>){const content=buildPreset(asString(input.preset),key(input.instanceId),input.sample===true);return {preset:input.preset,sample:input.sample===true,title:content.title,documents:content.documents.map(d=>({id:d.id,title:d.title,purpose:d.purpose,modules:d.objects.map(o=>o.type)})),allModulesAvailable:true,media:input.sample===true&&input.preset!=='blank'?18:0,notice:'追加到当前项目；共享对象使用新身份，不覆盖已有文档。示例回答、声音和画面均为演示资料。'};}
 async apply(id:string,input:Record<string,unknown>){let snapshot=await this.projects.read(id);if(snapshot.project.format!==2)throw new ProjectError('FORMAT_UPGRADE_REQUIRED','请先在副本升级为格式 2');const preset=presets.find(p=>p.id===input.preset);if(!preset)throw new ProjectError('INVALID_PRESET','未知预设');const prefix=key(input.instanceId),requestId=key(input.requestId),media:Record<string,string>={},descriptors:FileChange[]=[];
  if(input.sample===true&&preset.id!=='blank'){
   const {sampleMedia}=await import('../../shared/creative/sample-media.generated.ts');
   const index=buildCreativeIndex(snapshot);
   for(const file of sampleMedia){const stored=await this.projects.storeMedia(id,Buffer.from(file.data,'base64')),mediaId=`media-${stored.sha256}`;media[file.name]=mediaId;if(index.objects.some(x=>x.object.id===mediaId)||descriptors.some(d=>d.path===`docs/media/${mediaId}.md`))continue;
    const o:CreativeObject={schema:1,id:mediaId,type:'media',title:file.name,status:'confirmed',data:{...stored,durationMs:file.durationMs,originalName:file.name,permission:'虚构示例专用。二维图由项目生成器编写；eSpeak Mandarin 演示音，不含真人克隆。',demo:true}};
    descriptors.push({path:`docs/media/${mediaId}.md`,baseHash:null,text:`---\nid: doc-${mediaId}\ntype: guide\nstatus: draft\n---\n\n# ${file.name}\n\n${objectBlock(o)}\n`});
   }
  }
  const content=buildPreset(preset.id,prefix,input.sample===true,media);
  snapshot=await this.projects.runOperation(id,{...input,requestId},()=>{
   const changes:FileChange[]=[...descriptors,...content.documents.map(d=>({path:`docs/creative/${d.id}.md`,baseHash:null,text:`---\nid: ${d.id}\ntype: ${d.purpose==='quest'?'guide':(!snapshot.rootDocumentId&&['game','mixed'].includes(preset.id)&&d.id===prefix+'-doc-brief')?'gdd':'dd'}\nstatus: draft\npurpose: ${d.purpose}\nexample: ${input.sample===true}\n---\n\n# ${d.title}\n\n${d.body}\n\n${d.objects.map(objectBlock).join('\n\n')}\n`}))];
   const entry=snapshot.projectEntry!;const metadata=readHeader(entry.text).metadata,applied=Array.isArray(metadata.presets)?metadata.presets:[];
   changes.push({path:'PROJECT.md',baseHash:entry.hash,text:setMetadata(entry.text,{presets:[...applied,{id:preset.id,instanceId:prefix,sample:input.sample===true}],minimumAppVersion:'0.9.0-rc.2'})});
   return {projectId:id,requestId,baseRevision:snapshot.revision,actor:'user',reason:`追加${input.sample===true?'虚构示例':'起步框架'}：${content.title}（预设不限制模块）`,changes};
  });
  if(input.sample===true&&content.questIds.length)await this.seedDemonstration(id,prefix,content.questIds,content.standaloneTargets);
  return this.projects.read(id);
 }
 /** 明确标记的演示链使用真实问询/提案服务生成；不会对真实未选示例内容代答。 */
 private async seedDemonstration(id:string,prefix:string,questIds:string[],standaloneTargets:string[]){
  for(const [i,questId] of questIds.entries()){
   const count=i===1?3:1;
   for(let r=0;r<count;r++){
    let snapshot=await this.projects.read(id);const qid=`${prefix}-q${i}-${r}`;
    if(!snapshot.documents.some(d=>d.id===qid)){const quest=buildCreativeIndex(snapshot).objects.find(x=>x.object.id===questId)!;await this.creative.questRound(id,{requestId:`${prefix}-round-${i}-${r}`,questId,roundId:`${prefix}-round${i}-${r}`,baseHash:quest.hash,summary:r?'演示追问：保留上一轮原话，进一步核对影响。':'演示首轮：这些题目来自虚构资料，不表示真实模型已在线。',questions:[{id:qid,title:['出口线索应该在何时展示？','怎样让选择更可信？','是否延长交接后的停顿？','是否保留告别后的空镜？'][i],background:'【演示问题】请在练习副本中选择，或跳过。',options:['保留当前方案','调整表达，但不改变故事结果'],mode:'single'}]});}
    if(i>0&&(i!==1||r<count-1)){
     snapshot=await this.projects.read(id);const q=snapshot.documents.find(d=>d.id===qid)!;
     if(!q.text.includes('### 回答 '))await this.projects.answer(id,{requestId:`${prefix}-answer-${i}-${r}`,answers:[{documentId:qid,baseHash:q.hash,choices:[],text:'【演示回答，非用户真实决定】调整表达，保留故事结果；请在自己的练习中重新判断。',action:'回答'}]});
    }
   }
   if(i>=2){let snapshot=await this.projects.read(id);const q=snapshot.documents.find(d=>d.id===`${prefix}-q${i}-0`)!,proposalId=`${prefix}-proposal-${i}`,work=await this.projects.work(id),existing=work.items.find(w=>w.id===proposalId);
    const targets=[snapshot.documents.find(d=>d.id===`${prefix}-doc-dd4`)!,snapshot.documents.find(d=>d.id===`${prefix}-doc-dd5`)!];
    if(!existing){await this.projects.propose(id,{id:proposalId,title:`演示${i===2?'部分':'完整'}落实`,reason:'【演示提案】练习逐文件审核，非用户真实确认。',baseRevision:snapshot.revision!,questionIds:[q.id],dependencies:{[q.path]:q.hash},changes:[{path:q.path,baseHash:q.hash,text:q.text.replace('尚未形成。','演示解释：短暂停顿让信息有消化空间。').replace('尚未采纳。','演示决定：保留停顿，并核对音画同步。')},...targets.map(d=>({path:d.path,baseHash:d.hash,text:d.text+`\n\n演示审阅 ${i}：在此处保留一次停顿，后续通过排演确认。\n`}))]});}
    const current=(await this.projects.work(id)).items.find(w=>w.id===proposalId)!;if(current.state==='pending')await this.projects.acceptProposal(id,proposalId,i===2?[targets[0].path]:targets.map(d=>d.path));
   }
  }
  let snapshot=await this.projects.read(id);const standalone=[0,1].filter(i=>!snapshot.documents.some(d=>d.id===`${prefix}-standalone${i}`));
  if(standalone.length)await this.projects.publishQuestions(id,{requestId:`${prefix}-standalone-publish`,round:'独立问题演示',questions:standalone.map(i=>({id:`${prefix}-standalone${i}`,title:i?'这句对白是否需要旁白解释？':'地图上的距离需要标尺吗？',background:'【演示】独立问题不必归入 Quest。',options:['继续观察','记录为后续 Quest'],targets:standaloneTargets.filter(t=>snapshot.nodes.some(n=>n.id===t))}))});
  snapshot=await this.projects.read(id);if(!buildCreativeIndex(snapshot).objects.some(x=>x.object.id===`${prefix}-production`))await new ProductionService(this.projects).prepare(id,{requestId:`${prefix}-production-prepare`,batchId:`${prefix}-production`,title:'演示图片与配音生产包',purpose:'练习身份匹配；尚未向外部服务提交',targetIds:[`${prefix}-shot0`,`${prefix}-speech0`]});
 }
}
