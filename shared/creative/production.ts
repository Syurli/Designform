import { asData, asRows, asString, asStrings, type Data, type CreativeIndex, type CreativeObject } from './model.ts';
import { contentHash } from './content.ts';
export interface ProductionJob {
 id:string;targetId:string;panelId?:string;kind:'image'|'voice';title:string;prompt:string;
 dependencies:Record<string,string>;sourceRevision:string|null;state:'prepared'|'returned'|'adopted';
 candidates:{id:string;mediaId:string;createdAt:string;stale:boolean}[];adoptedMediaId?:string;referenceMediaIds:string[];
 dependencyMode?:'semantic-2';negativePrompt?:string;output?:{width?:number;height?:number;language?:string};promptEdited?:boolean;compiledPromptHash?:string;
}
export interface ProductionBundle {format:'cewen-production-1';projectId:string;batchId:string;sourceRevision:string|null;jobs:ProductionJob[];instructions:string}
export interface ProductionOptions {scope?:'all'|'missing'|'changed';selectedJobIds?:string[];overrides?:Record<string,{prompt?:string;negativePrompt?:string}>}
const outputs=new Set(['mediaId','sampleMediaId','adoptedMediaId','confirmation']);
function stripOutputs(value:unknown):unknown {if(Array.isArray(value))return value.map(stripOutputs);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!outputs.has(k)).map(([k,v])=>[k,stripOutputs(v)]));return value;}
/** 老任务依旧用原格式验哈希；不擅自改写已冻结批次。 */
export function generationHash(object:CreativeObject|undefined):string {
 if(!object)return '';const copy=structuredClone(object);const strip=(data:Data)=>{for(const key of Object.keys(data)){if(key==='mediaId')delete data[key];else if(Array.isArray(data[key]))for(const row of asRows(data[key]))strip(row);}};strip(copy.data);return contentHash(JSON.stringify(copy));
}
/** 图像与声音采用不同依赖投影。采用自身输出或改另一画面不会触发无关重做。 */
function projection(object:CreativeObject,kind:'image'|'voice',root:boolean,panelId?:string):unknown {
 const data=structuredClone(object.data);
 if(root){delete data.mediaId;delete data.adoptedMediaId;delete data.confirmation;}
 if(kind==='image'){
  if(object.type==='character'){delete data.voiceId;delete data.pronunciation;}
  if(object.type==='scene'){delete data.speechIds;}
  if(object.type==='shot'){delete data.speechIds;delete data.estimatedMs;if(root&&panelId){const p=asRows(data.panels).find(p=>p.id===panelId);data.panels=p?[JSON.parse(JSON.stringify(stripOutputs({...p,durationMs:undefined})))]:[];}}
 }else{
  if(object.type==='character')return {id:object.id,type:object.type,title:object.title,data:{identity:data.identity,personality:data.personality,voiceId:data.voiceId}};
  if(object.type==='speech')delete data.mediaId;
 }
 return {id:object.id,type:object.type,title:object.title,description:object.description??'',data};
}
function semanticHash(object:CreativeObject|undefined,job:Pick<ProductionJob,'kind'|'targetId'|'panelId'>){return object?contentHash(JSON.stringify(projection(object,job.kind,object.id===job.targetId,job.panelId))):'';}
export function jobStale(index:CreativeIndex,job:ProductionJob){const byId=new Map(index.objects.map(o=>[o.object.id,o]));return Object.entries(job.dependencies).some(([id,hash])=>(job.dependencyMode==='semantic-2'?semanticHash(byId.get(id)?.object,job):id===job.targetId?generationHash(byId.get(id)?.object):byId.get(id)?.hash)!==hash);}
export function productionJobs(data:Data):ProductionJob[]{return asRows(data.jobs) as unknown as ProductionJob[];}
/** 从场次/剧情线/序列展开生产对象；预设不参与能力判断，循环引用有界。 */
export function expandProductionTargets(index:CreativeIndex,targets:string[]):string[]{
 const byId=new Map(index.objects.map(o=>[o.object.id,o.object])),visited=new Set<string>(),result=new Set<string>(),queue=[...targets];
 for(let i=0;i<queue.length;i++){const id=queue[i];if(visited.has(id))continue;visited.add(id);if(visited.size>2000)throw new Error('范围超过 2000 个对象，请按场次分批');const o=byId.get(id);if(!o)throw new Error(`缺少对象 ${id}`);
  if(['character','location','map','shot','speech'].includes(o.type)){result.add(id);continue;}
  if(o.type==='reference')queue.push(asString(o.data.objectId));
  else if(o.type==='map-use')queue.push(asString(o.data.mapId));
  else if(o.type==='sequence'){queue.push(...asRows(o.data.items).map(i=>asString(i.shotId)),...asRows(o.data.audio).map(a=>asString(a.speechId)));}
  else if(o.type==='scene'){queue.push(...asStrings(o.data.speechIds),...index.objects.filter(x=>x.object.type==='shot'&&x.object.data.sceneId===id).map(x=>x.object.id));}
  else if(o.type==='storyline')queue.push(...asRows(o.data.nodes).map(n=>asString(n.sceneId)).filter(Boolean));
  else throw new Error(`“${o.title}”没有图片或配音生产目标，请选择角色、场次、镜头或台词`);
 }
 return [...result];
}
/** 提示词编译不会调用模型。媒体引用是明确参考，不将上一张结果循环作为自身依据。 */
export function prepareJobs(index:CreativeIndex,targetIds:string[],batchId:string,revision:string|null,options:ProductionOptions={}):ProductionJob[]{
 const byId=new Map(index.objects.map(x=>[x.object.id,x.object])),jobs:ProductionJob[]=[];
 const previous=index.objects.filter(o=>o.object.type==='production').flatMap(o=>productionJobs(o.object.data));
 for(const targetId of expandProductionTargets(index,targetIds)){
  const object=byId.get(targetId)!;const panels=object.type==='shot'?asRows(object.data.panels):[{} as Data];if(!panels.length)throw new Error(`${object.title} 尚无分镜画面，请先添加画面`);
  for(const panel of panels){
   const kind=object.type==='speech'?'voice':'image',panelId=asString(panel.id)||undefined;
   const job:ProductionJob={id:`job-${contentHash(`${batchId}:${targetId}:${panelId??''}`).slice(0,24)}`,targetId,...(panelId?{panelId}:{}),kind,title:object.title+(panelId?` / ${panelId}`:''),prompt:'',dependencies:{},sourceRevision:revision,state:'prepared',candidates:[],referenceMediaIds:[],dependencyMode:'semantic-2'};
   const context=new Map<string,CreativeObject>(),queue=[targetId];let cursor=0;
   while(cursor<queue.length){const id=queue[cursor++];if(context.has(id))continue;const dependency=byId.get(id);if(!dependency)throw new Error(`生成依据 ${id} 缺失；请先修复引用`);context.set(id,dependency);if(context.size>200)throw new Error('单任务依赖超过200个对象，请缩小内容范围');
    if(dependency.type==='media')continue;
    const raw=asData(projection(dependency,kind,id===targetId,panelId)),data=asData(raw.data);
    const allowed=kind==='voice'?new Set(['characterId','voiceId','sampleMediaId']):new Set(['characterId','characterIds','locationId','mapId','mapUseId','sceneId','mediaId','referenceMediaIds']);
    for(const [key,value] of Object.entries(data))if(allowed.has(key)){if(typeof value==='string'&&value)queue.push(value);else if(Array.isArray(value))queue.push(...asStrings(value));}
    // 分镜可明确选择角色造型。只把这版造型图作为参考，而不复制角色身份。
    if(kind==='image')for(const variant of asRows(data.characterVariants)){const character=byId.get(asString(variant.characterId));if(!character)throw new Error('角色造型指向缺失角色');queue.push(character.id);const chosen=asRows(character.data.variants).find(v=>v.id===variant.variantId);if(!chosen)throw new Error('选择的角色造型版本已移除');if(chosen.mediaId)queue.push(asString(chosen.mediaId));}
   }
   for(const [id,dependency] of context){job.dependencies[id]=semanticHash(dependency,job);if(dependency.type==='media')job.referenceMediaIds.push(id);}
   const fields=projection(object,kind,true,panelId),references=[...context.values()].filter(o=>o.id!==targetId&&o.type!=='media').map(o=>projection(o,kind,false));
   const base=`目标：${object.title}\n固定创作内容：${JSON.stringify(fields,null,2)}\n相关资料：${JSON.stringify(references,null,2)}\n保留上述身份、服装、事件和原话。遇到歧义应提问，不擅自新增事实。`;
   job.prompt=kind==='voice'?`只生成这一条台词的配音。\n${base}\n台词原文：${asString(object.data.text)}\n表演：${asString(object.data.performance)}\n不得朗读镜头说明、字段名或标签。`:`生成单张创作参考图。\n${base}\n当前画面：${asString(panel.caption)}\n输出单张，不拼接候选。`;
   if(job.prompt.length>120000)throw new Error('单任务提示词超限，请精简关联内容');job.compiledPromptHash=contentHash(job.prompt);
   const outputId=asString(panelId?panel.mediaId:object.data.mediaId),prior=previous.filter(j=>j.targetId===targetId&&j.panelId===panelId).at(-1);
   if(options.scope==='missing'&&byId.get(outputId)?.type==='media')continue;
   if(options.scope==='changed'&&prior&&!jobStale(index,prior))continue;
   if(options.selectedJobIds&&!options.selectedJobIds.includes(job.id))continue;
   const edit=options.overrides?.[job.id];if(edit){if(edit.prompt!==undefined){if(typeof edit.prompt!=='string'||!edit.prompt.trim()||edit.prompt.length>120000)throw new Error('编辑后的提示词需为非空且不超过120000字符');job.promptEdited=edit.prompt!==job.prompt;job.prompt=edit.prompt;}if(edit.negativePrompt!==undefined){if(typeof edit.negativePrompt!=='string'||edit.negativePrompt.length>10000)throw new Error('负向提示词超限');job.negativePrompt=edit.negativePrompt;}}
   jobs.push(job);
  }
 }
 if(jobs.length>500)throw new Error('每批最多500个任务，请按场次分批');
 for(const id of Object.keys(options.overrides??{}))if(!jobs.some(j=>j.id===id))throw new Error('提示词修改指向不在所选任务中的身份');
 return jobs;
}
export function readJobReceipt(value:unknown):{format:string;batchId:string;results:{jobId:string;filename:string;candidateId:string}[]}{const data=asData(value);if(data.format!=='cewen-results-1'||!asString(data.batchId))throw new Error('结果清单格式错误');if(!Array.isArray(data.results)||asRows(data.results).length!==data.results.length)throw new Error('结果清单包含无效行，未静默忽略');const results=asRows(data.results).map(r=>({jobId:asString(r.jobId),filename:asString(r.filename),candidateId:asString(r.candidateId)}));if(!results.length||results.length>1000)throw new Error('结果清单需要1～1000项');if(results.some(r=>!r.jobId||!r.candidateId||!r.filename||r.filename.split('/').some(p=>!p||p==='..'||p==='.')||r.filename.includes('\\')||r.filename.includes('\0')||r.filename.startsWith('/')))throw new Error('结果身份或文件路径无效');return {format:'cewen-results-1',batchId:asString(data.batchId),results};}
