import {decisionBasis,decisionState} from '../../shared/creative/decisions.ts';
import {queryObjects,creativeStatistics} from '../../shared/creative/query.ts';
import {parseAnchor,resolveAnchor} from '../../shared/creative/anchors.ts';
import {prepareWanleiExchange,validateWanleiReturn} from '../../shared/creative/bridge.ts';
import { APP_VERSION } from '../../shared/version.ts';
import { detectMedia } from '../../shared/creative/media.ts';
import { PresetService } from './preset-service.ts';
import { ProductionService } from './production-service.ts';
import type { ProjectService } from '../projects.ts';
import type { ProjectSnapshot, FileChange } from '../../shared/model.ts';
import { buildCreativeIndex, objectBlock, replaceObject, contentHash, objectContext } from '../../shared/creative/content.ts';
import { asData, asRows, asString, asStrings, asNumber, objectIdPattern, type CreativeObject, type Data, type LocatedObject } from '../../shared/creative/model.ts';
import { moduleRegistry, moduleCatalog, validateObject } from '../../shared/creative/registry.ts';
import { questionDocument, setMetadata } from '../../shared/editing.ts';
import { inquiry, section } from '../../shared/inquiry.ts';
import { readHeader } from '../../shared/markdown.ts';
import { randomUUID } from '../platform.ts';
import { ProjectError } from '../files.ts';

const requireString=(value:unknown,name:string,max=20000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new ProjectError('INVALID_REQUEST',`${name}需为非空文字（最多 ${max} 字符）`);return value;};
export function requireId(value:unknown,name='身份'){const id=requireString(value,name,120);if(!objectIdPattern.test(id))throw new ProjectError('INVALID_ID',`${name}格式无效`);return id;}
export const splitIds=(value:unknown)=>asString(value).split(/[,，\s]+/).filter(Boolean);
export function findObject(snapshot:ProjectSnapshot,id:string):LocatedObject {const entries=buildCreativeIndex(snapshot).objects.filter(x=>x.object.id===id);if(entries.length!==1)throw new ProjectError('MISSING_OBJECT',`对象 ${id} 缺失或身份不唯一`);return entries[0];}
export function makeDocument(id:string,title:string,objects:CreativeObject[],body=''){return `---\nid: ${id}\ntype: ${objects.every(o=>['quest','media','production'].includes(o.type))?'guide':'dd'}\nstatus: draft\n---\n\n# ${title.replace(/[\r\n]/g,' ')}\n\n${body}\n\n${objects.map(objectBlock).join('\n\n')}\n`;}
function guard(snapshot:ProjectSnapshot){if(snapshot.project.format!==2)throw new ProjectError('FORMAT_UPGRADE_REQUIRED','本功能需要格式 2；请先在独立副本升级原项目');if(snapshot.historical)throw new ProjectError('HISTORICAL_READ_ONLY','历史只读');}
/** Quest、对象与生产元数据最终都走 ProjectService.commit；源码不是另一个可漂移数据库。 */
export class CreativeService {
 constructor(readonly projects:ProjectService){}
 async objects(id:string,input:Record<string,unknown>={}) {
  const snapshot=await this.projects.read(id),index=buildCreativeIndex(snapshot);
  if(input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||Number(input.offset)<0))throw new ProjectError('INVALID_REQUEST','分页起点无效');
  const result=queryObjects(index,{text:asString(input.query),type:asString(input.type),status:asString(input.status),tag:asString(input.tag),relatedId:asString(input.relatedId),questId:asString(input.questId),missingMedia:input.missingMedia===true,offset:asNumber(input.offset),limit:asNumber(input.limit,40)});
  const uses=new Map<string,number>();for(const r of index.references)uses.set(r.targetId,(uses.get(r.targetId)??0)+1);
  return {revision:snapshot.revision,fingerprint:snapshot.fingerprint,recoveryRequired:snapshot.recoveryRequired,diagnostics:snapshot.diagnostics,...result,statistics:creativeStatistics(index),objects:result.objects.map(({object,path,hash,documentId,documentHash})=>({id:object.id,type:object.type,title:object.title,description:object.description,status:object.status,tags:object.tags,path,hash,documentId,documentHash,uses:uses.get(object.id)??0}))};
 }
 async readObject(id:string,objectId:string){const snapshot=await this.projects.read(id),item=findObject(snapshot,objectId);return {revision:snapshot.revision,...structuredClone(item),diagnostics:snapshot.diagnostics,recoveryRequired:snapshot.recoveryRequired};}
 async context(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);return {revision:snapshot.revision,fingerprint:snapshot.fingerprint,projectEntry:snapshot.projectEntry,recoveryRequired:snapshot.recoveryRequired,diagnostics:snapshot.diagnostics,objects:objectContext(buildCreativeIndex(snapshot),asStrings(input.objectIds),Math.min(200000,Math.max(1000,asNumber(input.budget,100000))))};}
 async saveObject(id:string,input:Record<string,unknown>) {
  const snapshot=await this.projects.read(id);guard(snapshot);const o=input.object as CreativeObject;
  const errors=validateObject(o);if(errors.length)throw new ProjectError('INVALID_MODULE',errors.join('；'));
  if(['media','production'].includes(o.type))throw new ProjectError('MANAGED_MODULE','媒体与生产记录请使用对应的导入／生产入口');
  return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{
   const index=buildCreativeIndex(snapshot),located=index.objects.find(x=>x.object.id===o.id),documentId=requireId(input.documentId,'目标文档'),doc=snapshot.documents.find(d=>d.id===documentId);
   if(!doc||doc.type==='question')throw new ProjectError('INVALID_DOCUMENT','选择普通创作文档，不直接覆写问题原始回答');
   if(doc.hash!==input.baseHash)throw new ProjectError('FILE_CONFLICT','目标文档已变化，请保留输入并重新比较');
   if(located&&located.documentId!==doc.id)throw new ProjectError('OBJECT_ALREADY_EXISTS','这是另一文档拥有的共享对象，请引用或复制为新对象');
   if(located&&(located.object.type!==o.type||located.object.schema!==o.schema))throw new ProjectError('OBJECT_TYPE_CHANGED','不能通过编辑改变对象类型或 schema');
   if(o.type==='decision'&&JSON.stringify(o.data.confirmation??null)!==JSON.stringify(located?.object.data.confirmation??null))throw new ProjectError('USER_CONFIRMATION_REQUIRED','决定确认只能通过用户明确确认入口记录');
   if(o.type==='quest') {
    if(JSON.stringify(o.data.rounds??[])!==JSON.stringify(located?.object.data.rounds??[]))throw new ProjectError('ROUND_IMMUTABLE','轮次记录只能追加，不能通过通用编辑改写');
    if(o.data.state==='closed'&&!asString(o.data.closureReason).trim())throw new ProjectError('CLOSURE_REASON_REQUIRED','关闭 Quest 需要实际原因');
   }
   const text=located?replaceObject(doc.text,located,o):doc.text.trimEnd()+'\n\n'+objectBlock(o)+'\n';
   return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'user' as const,reason:`${located?'编辑':'插入'}${moduleRegistry.get(o.type)!.title}：${o.title}`,changes:[{path:doc.path,baseHash:doc.hash,text}]};
  });
 }
 async createObjectDocument(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);guard(snapshot);const type=requireString(input.type,'模块类型'),title=requireString(input.title,'标题',200),definition=moduleRegistry.get(type);if(!definition||['media','production'].includes(type))throw new ProjectError('INVALID_MODULE','请使用对应的专用入口');
  return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{const objectId=requireId(input.objectId),documentId=requireId(input.documentId),object=definition.create(objectId,title);object.data={...object.data,...asData(input.data)};object.description=asString(input.description);if(type==='quest')object.data.rounds=[];if(type==='decision')delete object.data.confirmation;const errors=validateObject(object);if(errors.length)throw new ProjectError('INVALID_MODULE',errors.join('；'));return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'user' as const,reason:`创建${definition.title}：${title}`,changes:[{path:`docs/creative/${documentId}.md`,baseHash:null,text:makeDocument(documentId,title,[object])}]};});}
 async createQuest(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);guard(snapshot);
  return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{
   const questId=requireId(input.questId),quest=moduleRegistry.get('quest')!.create(questId,requireString(input.title,'任务标题',200));quest.data.goal=requireString(input.goal,'目标');quest.data.scope=asString(input.scope);quest.data.targetIds=asStrings(input.targetIds);quest.data.documentIds=asString(input.documentIds);quest.data.anchor=JSON.parse(JSON.stringify(parseAnchor(input.anchor)));
   for(const target of asStrings(quest.data.targetIds))findObject(snapshot,target);
   for(const target of splitIds(input.documentIds))if(!snapshot.documents.some(d=>d.id===target))throw new ProjectError('MISSING_DOCUMENT','关联文档不存在');
   return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'llm' as const,reason:`发起 Quest：${quest.title}`,changes:[{path:`docs/quests/${questId}.md`,baseHash:null,text:makeDocument(`doc-${questId}`,quest.title,[quest],'Quest 是创作讨论，不代表已确认规则。')}]};
  });
 }
 async questRound(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);guard(snapshot);
  return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{
   const questId=requireId(input.questId),located=findObject(snapshot,questId),quest=structuredClone(located.object);if(quest.type!=='quest')throw new ProjectError('INVALID_QUEST','目标不是 Quest');
   if(located.hash!==input.baseHash)throw new ProjectError('QUEST_CONFLICT','Quest 已变化，请读取最新轮次');
   if(!['open'].includes(asString(quest.data.state)))throw new ProjectError('QUEST_PAUSED','请先由用户重新打开 Quest');
   const questions=asRows(input.questions);if(!questions.length||questions.length>30)throw new ProjectError('INVALID_QUESTIONS','每轮需要 1～30 个问题');
   const roundId=requireId(input.roundId),rounds=asRows(quest.data.rounds);if(rounds.some(r=>r.id===roundId))throw new ProjectError('ROUND_EXISTS','此轮已存在');
   const seen=new Set<string>(),changes:FileChange[]=[],documents=new Set(splitIds(quest.data.documentIds));
   for(const target of asStrings(quest.data.targetIds))documents.add(findObject(snapshot,target).documentId);
   for(const q of questions){const qid=requireId(q.id,'问题身份');if(seen.has(qid)||snapshot.documents.some(d=>d.id===qid))throw new ProjectError('QUESTION_EXISTS','问题身份重复');seen.add(qid);
    for(const target of asStrings(q.targetIds))findObject(snapshot,target);
    if(q.follows&&!snapshot.documents.some(d=>d.type==='question'&&d.id===q.follows))throw new ProjectError('MISSING_QUESTION','前题不存在');
    if(q.mode!==undefined&&!['single','multiple'].includes(asString(q.mode)))throw new ProjectError('INVALID_QUESTION','作答模式无效');
    const when=asData(q.when);if(when.questionId&&!snapshot.documents.some(d=>d.type==='question'&&d.id===when.questionId))throw new ProjectError('INVALID_CONDITION','条件题需要已发布前题');
    const options=asStrings(q.options);if(options.length>26)throw new ProjectError('INVALID_QUESTION','单题最多 26 个选项');
    const targets=[...documents].filter(doc=>snapshot.nodes.some(n=>n.id===doc));
    let text=questionDocument({id:qid,title:requireString(q.title,'问题标题',200),background:requireString(q.background,'问题背景'),options,targets,revision:snapshot.revision,round:`${quest.title} / 第 ${rounds.length+1} 轮`,mode:q.mode==='multiple'?'multiple':'single',...(when.questionId?{when:{questionId:requireId(when.questionId),...(when.option?{option:asString(when.option)}:{})}}:{}),...(q.follows?{follows:requireId(q.follows),condition:asString(q.condition)}:{})});
    text=setMetadata(text,{questId,roundId,objectTargets:asStrings(q.targetIds).length?asStrings(q.targetIds):asStrings(quest.data.targetIds),anchor:quest.data.anchor});changes.push({path:`docs/questions/${qid}.md`,baseHash:null,text});
   }
   quest.data.rounds=[...rounds,{id:roundId,number:rounds.length+1,summary:asString(input.summary),questionIds:[...seen],sourceRevision:snapshot.revision,createdAt:new Date().toISOString()}];
   const doc=snapshot.documents.find(d=>d.id===located.documentId)!;changes.push({path:doc.path,baseHash:doc.hash,text:replaceObject(doc.text,located,quest)});
   return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'llm' as const,reason:`Quest ${quest.title}：第 ${rounds.length+1} 轮`,changes,dependencies:asData(input.dependencies) as Record<string,string>};
  });
 }
 /** 与“已回答”和“提案采纳”分开的用户决定确认。MCP 不提供此操作。 */
 async confirmDecision(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);guard(snapshot);if(input.confirmed!==true)throw new ProjectError('CONSENT_REQUIRED','请由用户明确确认决定内容');return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{
  const located=findObject(snapshot,requireId(input.objectId)),object=structuredClone(located.object);if(object.type!=='decision')throw new ProjectError('INVALID_DECISION','目标不是决定记录');if(input.baseHash!==located.hash)throw new ProjectError('OBJECT_CONFLICT','决定内容已变化');if(!asString(object.data.text).trim())throw new ProjectError('EMPTY_DECISION','决定内容不能为空');
  const basis=decisionBasis(object,snapshot);object.data.confirmation={actor:'user',requestId:asString(input.requestId),revision:snapshot.revision,at:new Date().toISOString(),basis};
  const doc=snapshot.documents.find(d=>d.id===located.documentId)!;return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'user' as const,reason:`用户确认决定：${object.title}`,changes:[{path:doc.path,baseHash:doc.hash,text:replaceObject(doc.text,located,object)}]};});}
 async questRead(id:string,questId:string){const snapshot=await this.projects.read(id),located=findObject(snapshot,questId);if(located.object.type!=='quest')throw new ProjectError('INVALID_QUEST','目标不是 Quest');
  const questions=snapshot.documents.filter(d=>d.type==='question'&&readHeader(d.text).metadata.questId===questId),work=await this.projects.work(id);
  const proposals=work.items.filter(w=>w.kind==='proposal'&&w.scope==='project'&&asStrings((w.payload as {questionIds?:string[]})?.questionIds).some(q=>questions.some(d=>d.id===q))).map(w=>({id:w.id,title:w.title,state:w.state,appliedFiles:w.appliedFiles,updatedAt:w.updatedAt,needsReview:Object.entries(w.appliedFiles??{}).some(([p,h])=>(snapshot.files?.[p]??null)!==h)}));
  const decisions=buildCreativeIndex(snapshot).objects.filter(o=>o.object.type==='decision'&&splitIds(o.object.data.questionIds).some(qid=>questions.some(q=>q.id===qid))).map(o=>({id:o.object.id,title:o.object.title,state:decisionState(o.object,snapshot)}));
  const answered=questions.filter(q=>section(q.text,'用户原始回答').text.includes('### 回答 ')).length;
  return {revision:snapshot.revision,hash:located.hash,documentHash:located.documentHash,quest:structuredClone(located.object),decisions,decisionState:decisions.some(d=>d.state==='needs-review')?'needs-review':decisions.length&&decisions.every(d=>d.state==='confirmed')?'confirmed':'not-confirmed',questions:questions.map(q=>({...inquiry(q),path:q.path,hash:q.hash,metadata:readHeader(q.text).metadata})),proposals,answerState:answered===questions.length&&questions.length?'answered':'waiting-user',implementationState:proposals.length&&proposals.every(p=>p.state==='accepted'&&!p.needsReview)?'applied':proposals.some(p=>Object.keys(p.appliedFiles??{}).length)?'partially-applied':'not-applied',recoveryRequired:snapshot.recoveryRequired,diagnostics:snapshot.diagnostics};
 }
 /** 游标指向真实公开修订，不维护第二份可以谎报完成的事件数据库。 */
 async questEvents(id:string,input:Record<string,unknown>){
  const snapshot=await this.projects.read(id),questId=requireId(input.questId),located=findObject(snapshot,questId),entries=(await this.projects.versions(id)).filter(e=>e.valid),since=asString(input.cursor),at=since?entries.findIndex(e=>e.manifest.id===since):-1;
  if(since&&at<0)throw new ProjectError('CURSOR_EXPIRED','游标不属于当前版本链，请完整重读 Quest');
  const index=buildCreativeIndex(snapshot),paths=new Set([located.path,...snapshot.documents.filter(d=>d.type==='question'&&readHeader(d.text).metadata.questId===questId).map(d=>d.path)]);
  for(const target of asStrings(located.object.data.targetIds)){const object=index.objects.find(o=>o.object.id===target);if(object)paths.add(object.path);}
  // 补上游标版本的原路径，移动或删除来源后仍能报告变更。
  if(since){const previous=await this.projects.revision(id,since);for(const doc of previous.documents){if(doc.type==='question'&&readHeader(doc.text).metadata.questId===questId)paths.add(doc.path);}const oldIndex=buildCreativeIndex(previous),oldQuest=oldIndex.objects.find(o=>o.object.id===questId);if(oldQuest){paths.add(oldQuest.path);for(const target of asStrings(oldQuest.object.data.targetIds)){const object=oldIndex.objects.find(o=>o.object.id===target);if(object)paths.add(object.path);}}}
  const scanned=entries.slice(at+1,at+26),events=scanned.filter(e=>e.manifest.changedPaths.some(p=>paths.has(p))).map(e=>({revision:e.manifest.id,reason:e.manifest.reason,actor:e.manifest.actor,at:e.manifest.createdAt,changedPaths:e.manifest.changedPaths.filter(p=>paths.has(p))}));
  const changed=new Set(events.flatMap(e=>e.changedPaths)),cursor=scanned.at(-1)?.manifest.id??since??null;
  // 内容读取固定到游标边界，而不是将最新内容与旧分页游标混合。
  const boundary=cursor?await this.projects.revision(id,cursor):snapshot;
  const changedDocuments=boundary.documents.filter(d=>changed.has(d.path)).map(d=>({id:d.id,path:d.path,hash:d.hash,text:d.text})),deletedPaths=[...changed].filter(path=>!boundary.files?.[path]);
  const state=await this.questRead(id,questId),{questions,quest,...latestStatus}=state;
  const result={events,cursor,hasMore:at+1+scanned.length<entries.length,headRevision:snapshot.revision,changedDocuments,deletedPaths,latestStatus,...(!since?{initialQuest:quest}:{})};
  if(JSON.stringify(result).length>200000)throw new ProjectError('DELTA_TOO_LARGE','增量正文超过预算，请用事件路径与分段文档工具重新读取。');return result;
 }
 /** 显式重定位或归入 Quest，不改写已发布问题、回答或决定。 */
 async linkQuestion(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id);guard(snapshot);return this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>{
  const doc=snapshot.documents.find(d=>d.id===requireId(input.questionId)&&d.type==='question');if(!doc)throw new ProjectError('MISSING_QUESTION','问题不存在');if(doc.hash!==input.baseHash)throw new ProjectError('QUESTION_CHANGED','问题或回答已变化，请重新读取');
  const patch:Record<string,unknown>={};if(input.anchor!==undefined){const anchor=parseAnchor(input.anchor),resolution=resolveAnchor(snapshot,anchor);if(['missing','ambiguous'].includes(resolution.state))throw new ProjectError('ANCHOR_UNRESOLVED',resolution.reason);patch.anchor=anchor;}
  if(input.questId!==undefined){const qid=asString(input.questId);if(qid&&findObject(snapshot,qid).object.type!=='quest')throw new ProjectError('INVALID_QUEST','选择实际 Quest');patch.questId=qid||undefined;}
  return {projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'user' as const,reason:'更新问题的明确关联（原始回答保留）',changes:[{path:doc.path,baseHash:doc.hash,text:setMetadata(doc.text,patch)}]};});
 }
 async registerMedia(id:string,input:Record<string,unknown>,bytes:Uint8Array){const snapshot=await this.projects.read(id);guard(snapshot);const media=await this.projects.storeMedia(id,bytes),objectId=`media-${media.sha256}`,existing=buildCreativeIndex(snapshot).objects.find(o=>o.object.id===objectId);if(existing)return {snapshot,mediaId:objectId,duplicate:true};
  const o:CreativeObject={schema:1,id:objectId,type:'media',title:asString(input.name,'导入素材').slice(0,200),status:'draft',data:{...media,originalName:asString(input.name),permission:asString(input.permission),durationMs:asNumber(input.durationMs),source:'用户导入；尚未采用'}};
  const result=await this.projects.runOperation(id,{...input,requestId:requireString(input.requestId,'请求 ID',180)},()=>({projectId:id,requestId:asString(input.requestId),baseRevision:snapshot.revision,actor:'user',reason:`接收素材候选：${o.title}`,changes:[{path:`docs/media/${objectId}.md`,baseHash:null,text:makeDocument(`doc-${objectId}`,o.title,[o])}]}));return {snapshot:result,mediaId:objectId,duplicate:false};
 }
 async readMedia(id:string,input:Record<string,unknown>){const snapshot=await this.projects.read(id),object=findObject(snapshot,requireId(input.mediaId)).object;if(object.type!=='media')throw new ProjectError('INVALID_MEDIA','对象不是媒体');const metadata={mediaId:object.id,...object.data};if(input.includeContent!==true)return metadata;const bytes=await this.projects.asset(id,asString(object.data.path));if(bytes.length>5*1024*1024)throw new ProjectError('MEDIA_TOO_LARGE','MCP 媒体内容读取最多 5 MiB');const media=detectMedia(bytes);return {...metadata,mime:media.mime,data:bytes.toString('base64')};}
 capabilities(){return {appVersion:APP_VERSION,projectFormats:[1,2],creativeFormat:2,moduleSchema:1,modules:moduleCatalog(),legacyModules:['dialogue','palette'],permissions:{answers:'user-only',adoptProposal:'user-only',submitProduction:'explicit-user-approval',privateWorkspace:'not-shared'},limits:{contextCharacters:200000,objectPage:100,questionRound:30,mediaBytes:64*1024*1024},hostContinuation:'显式续轮请求；MCP 心跳不等于模型正在生成'};}
 async action(id:string,input:Record<string,unknown>):Promise<unknown>{switch(input.action){case 'decision-confirm':return this.confirmDecision(id,input);case 'question-link':return this.linkQuestion(id,input);case 'anchor-read':return resolveAnchor(await this.projects.read(id),input.anchor);case 'wanlei-export':{const s=await this.projects.read(id);return prepareWanleiExchange(buildCreativeIndex(s),id,s.revision,asStrings(input.objectIds));}case 'wanlei-preflight':{const s=await this.projects.read(id);return validateWanleiReturn(buildCreativeIndex(s),id,input.package);}case 'media-read':return this.readMedia(id,input);case 'preset-preview':return new PresetService(this.projects,this).preview(input);case 'preset-apply':return new PresetService(this.projects,this).apply(id,input);case 'production-preview':return new ProductionService(this.projects).preview(id,input);case 'production-prepare':return new ProductionService(this.projects).prepare(id,input);case 'production-read':return new ProductionService(this.projects).read(id,requireId(input.batchId));case 'production-result':return new ProductionService(this.projects).recordResult(id,input);case 'production-adopt':return new ProductionService(this.projects).adopt(id,input);case 'production-bundle':return new ProductionService(this.projects).bundle(id,requireId(input.batchId));case 'playback-bundle':return new ProductionService(this.projects).playbackBundle(id,requireId(input.sequenceId),asString(input.revision)||undefined);case 'objects':return this.objects(id,input);case 'read-object':return this.readObject(id,requireId(input.objectId));case 'context':return this.context(id,input);case 'save-object':return this.saveObject(id,input);case 'new-object':return this.createObjectDocument(id,input);case 'quest-create':return this.createQuest(id,input);case 'quest-round':return this.questRound(id,input);case 'quest-read':return this.questRead(id,requireId(input.questId));case 'quest-events':return this.questEvents(id,input);default:throw new ProjectError('UNKNOWN_CREATIVE_ACTION','未知创作操作');}}
}
