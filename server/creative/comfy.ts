import {buildCreativeIndex} from '../../shared/creative/content.ts';
import {detectMedia} from '../../shared/creative/media.ts';
import type { ProjectService } from '../projects.ts';
import { CreativeService } from './service.ts';
import { ProductionService } from './production-service.ts';
import { asString,asData,asRows } from '../../shared/creative/model.ts';
import { randomUUID,Buffer } from '../platform.ts';
import { ProjectError } from '../files.ts';
interface Run {id:string;batchId:string;jobId:string;promptId:string;url:string;state:string;createdAt:string;message?:string;collected?:boolean;omittedReferences?:string[];referenceOmissionReason?:string;negativeOmitted?:boolean}
/** 仅桌面回环连接器；队列返回不等于采用。不会使用全局 interrupt 中断其他任务。 */
export class ComfyConnector {
 constructor(private projects:ProjectService){}
 private static queues=new Map<string,Promise<unknown>>();
 /** 同进程同项目串行运行，持久化 submitting/uncertain 阻止重入或崩溃后盲目重试。 */
 async action(id:string,input:Record<string,unknown>){
  const previous=ComfyConnector.queues.get(id)??Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>this.perform(id,input));ComfyConnector.queues.set(id,next);
  try{return await next;}finally{if(ComfyConnector.queues.get(id)===next)ComfyConnector.queues.delete(id);}
 }
 private endpoint(raw:unknown){const url=new URL(asString(raw));if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new ProjectError('CONNECTOR_URL_DENIED','只接受明确指定的本机 ComfyUI HTTP 回环地址，不接受凭证、远程地址或子路径');return url.origin;}
 private async json(url:string,path:string,input?:unknown){const response=await fetch(url+path,{method:input===undefined?'GET':'POST',...(input===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok)throw new ProjectError('CONNECTOR_FAILED',`ComfyUI 返回 ${response.status}`);return await response.json();}
 private async perform(id:string,input:Record<string,unknown>){
  const action=asString(input.operation),saved=await this.projects.connectorRecord(id),runs=(Array.isArray(saved.runs)?saved.runs:[]) as Run[];
  if(action==='status'){
   if(input.refresh===true){for(const run of runs.filter(r=>r.promptId&&['submitted','running'].includes(r.state)).slice(0,20)){try{const url=this.endpoint(run.url),h=await this.json(url,'/history/'+encodeURIComponent(run.promptId));if(h[run.promptId])run.state=h[run.promptId].status?.status_str==='error'?'failed':'complete';else{const q=await this.json(url,'/queue');run.state=(q.queue_running??[]).some((row:unknown[])=>row[1]===run.promptId)?'running':'submitted';}}catch(e){run.message='状态暂不可用：'+(e as Error).message;}}await this.projects.connectorRecord(id,{runs});}
   return {runs,refreshed:input.refresh===true};}

  if(action==='check'){const url=this.endpoint(input.url),info=await this.json(url,'/system_stats');return {url,available:true,system:info.system??{},notice:'连接成功不表示模型文件、工作流或显存已通过生产验证。'};}
  if(action==='submit'){
   if(input.confirmed!==true)throw new ProjectError('CONSENT_REQUIRED','请先审核工作流与本次提示词，再明确提交');
   const url=this.endpoint(input.url),batch=await new ProductionService(this.projects).read(id,asString(input.batchId)),job=batch.jobs.find(j=>j.id===input.jobId);if(!job||job.kind!=='image')throw new ProjectError('INVALID_JOB','此适配器当前只提交图片任务');if(job.stale)throw new ProjectError('STALE_JOB','依据已变化，请重新准备批次');
   const prompt=structuredClone(asData(input.workflow)),node=asData(prompt[asString(input.textNode)]),inputs=asData(node.inputs);if(typeof inputs.text!=='string')throw new ProjectError('INVALID_WORKFLOW','指定节点没有 text 输入。请选择已审核的 ComfyUI API 工作流');
   if(JSON.stringify(prompt).length>2*1024*1024||Object.keys(prompt).length>300)throw new ProjectError('WORKFLOW_TOO_LARGE','工作流超出本次范围');
   const previous=runs.find(r=>r.jobId===job.id&&['submitting','submitted','running','uncertain','complete'].includes(r.state));if(previous)throw new ProjectError('RUN_EXISTS','已有运行或不确定提交，请检查原记录，避免重复生成');
   inputs.text=job.prompt;node.inputs=inputs;prompt[asString(input.textNode)]=node;
   if(job.negativePrompt){const negative=asData(prompt[asString(input.negativeNode)]),negativeInputs=asData(negative.inputs);if(typeof negativeInputs.text==='string'&&asString(input.negativeNode)!==asString(input.textNode)){negativeInputs.text=job.negativePrompt;negative.inputs=negativeInputs;prompt[asString(input.negativeNode)]=negative;}else if(input.omitNegative!==true)throw new ProjectError('NEGATIVE_MAPPING_REQUIRED','工作流未指定负向文本输入；请选择节点或明确确认本次忽略负向提示词');}
   const bindings=asRows(input.referenceBindings),bound=new Set<string>(),usedNodes=new Set<string>();
   for(const binding of bindings){const mediaId=asString(binding.mediaId),nodeId=asString(binding.nodeId),node=asData(prompt[nodeId]),inputs=asData(node.inputs);if(!job.referenceMediaIds.includes(mediaId)||bound.has(mediaId)||usedNodes.has(nodeId)||typeof inputs.image!=='string')throw new ProjectError('INVALID_REFERENCE_BINDING','参考图必须来自任务清单，且逐张绑定不同的 image 输入节点');bound.add(mediaId);usedNodes.add(nodeId);}
   const omitted=job.referenceMediaIds.filter(mediaId=>!bound.has(mediaId));if(omitted.length&&(input.omitReferences!==true||!asString(input.referenceOmissionReason).trim()))throw new ProjectError('REFERENCE_MAPPING_REQUIRED','尚有参考资料未绑定；请映射参考图，或明确填写本次不使用这些参考的原因');
   if(bindings.length>12)throw new ProjectError('REFERENCE_LIMIT','单次最多上传12张明确参考，请精简任务资料');
   const snapshot=await this.projects.read(id),index=buildCreativeIndex(snapshot);
   for(const binding of bindings){const media=index.objects.find(o=>o.object.id===binding.mediaId)?.object;if(media?.type!=='media')throw new ProjectError('MISSING_REFERENCE','参考媒体不存在');const bytes=await this.projects.asset(id,asString(media.data.path)),type=detectMedia(bytes);if(type.kind!=='image'||bytes.length>10*1024*1024)throw new ProjectError('REFERENCE_LIMIT','此图片适配器的单张参考图需不超过10 MiB');
    const form=new FormData();form.set('image',new Blob([new Uint8Array(bytes)],{type:type.mime}),`cewen-${asString(media.data.sha256)}.${type.extension}`);form.set('type','input');form.set('subfolder','cewen');form.set('overwrite','false');
    const response=await fetch(url+'/upload/image',{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new ProjectError('REFERENCE_UPLOAD_FAILED',`参考图上传失败（${response.status}）；尚未提交生成队列`);const uploaded=asData(await response.json()),name=asString(uploaded.name),folder=asString(uploaded.subfolder);if(!name||/[\\/]/.test(name)||[name,...folder.split('/')].some(p=>p==='..'||p==='.')||folder.startsWith('/')||folder.includes('\\')||uploaded.type!=='input')throw new ProjectError('UNSAFE_REFERENCE_RESULT','参考图接口返回了非预期路径；未提交生成');
    const target=asData(prompt[asString(binding.nodeId)]),inputs=asData(target.inputs);inputs.image=[folder,name].filter(Boolean).join('/');target.inputs=inputs;prompt[asString(binding.nodeId)]=target;
   }

   const run:Run={id:randomUUID(),batchId:batch.batch.id,jobId:job.id,promptId:'',url,state:'submitting',omittedReferences:omitted,referenceOmissionReason:asString(input.referenceOmissionReason),negativeOmitted:!!job.negativePrompt&&!input.negativeNode,createdAt:new Date().toISOString()};runs.push(run);await this.projects.connectorRecord(id,{runs});
   try{const result=await this.json(url,'/prompt',{prompt,client_id:run.id,extra_data:{cewen:{batchId:run.batchId,jobId:run.jobId}}});if(typeof result.prompt_id!=='string')throw new Error(JSON.stringify(result.error??result.node_errors??'无 prompt_id'));run.promptId=result.prompt_id;run.state='submitted';await this.projects.connectorRecord(id,{runs});return run;}
   catch(e){run.state='uncertain';run.message='提交结果不确定，禁止自动重试。请在 ComfyUI 检查队列：'+(e as Error).message;await this.projects.connectorRecord(id,{runs});throw new ProjectError('SUBMISSION_UNCERTAIN',run.message);}
  }
  const run=runs.find(r=>r.id===input.runId);if(!run||!run.promptId)throw new ProjectError('MISSING_RUN','找不到已确认的运行');
  run.url=this.endpoint(run.url);
  if(action==='cancel'){const queue=await this.json(run.url,'/queue'),pending=(queue.queue_pending??[]) as unknown[][];if(!pending.some(row=>row[1]===run.promptId))return {canceled:false,message:'任务已开始或结束；为避免影响其他任务，未调用全局中断。请在 ComfyUI 手动检查。'};await this.json(run.url,'/queue',{delete:[run.promptId]});run.state='canceled';await this.projects.connectorRecord(id,{runs});return {canceled:true};}
  if(action==='collect'){
   const history=await this.json(run.url,`/history/${encodeURIComponent(run.promptId)}`),result=history[run.promptId];if(!result){return {state:'pending',message:'尚无完成结果，请稍后主动刷新'};}
   if(result.status?.status_str==='error'){run.state='failed';await this.projects.connectorRecord(id,{runs});return {state:'failed',message:'ComfyUI 执行失败，请查看其节点错误；未自动重试。'};}
   const images=Object.values(result.outputs??{}).flatMap(o=>asRows(asData(o).images)).slice(0,20);if(!images.length)return {state:'no-images',message:'输出中没有可识别图片，未把任意文件当作图片回导。'};
   if(run.collected)return {state:'complete',duplicate:true};
   const creative=new CreativeService(this.projects),production=new ProductionService(this.projects);let count=0;
   for(const image of images){const filename=asString(image.filename),subfolder=asString(image.subfolder);if(!filename||/[\\/]/.test(filename)||[filename,...subfolder.split('/')].some(x=>x==='..'||x==='.')||subfolder.startsWith('/')||subfolder.includes('\\')||image.type!=='output')throw new ProjectError('UNSAFE_OUTPUT','只回导此运行历史声明的 output 图片');
    const query=new URLSearchParams({filename,subfolder,type:'output'}),response=await fetch(run.url+'/view?'+query,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok||Number(response.headers.get('content-length'))>64*1024*1024)throw new ProjectError('OUTPUT_TOO_LARGE','图片输出读取失败或过大');
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>64*1024*1024){await reader.cancel();throw new ProjectError('OUTPUT_TOO_LARGE','输出超过 64 MiB');}chunks.push(next.value);}
    const media=await creative.registerMedia(id,{requestId:`comfy-media-${run.id}-${count}`,name:filename,permission:'用户明确提交的本机 ComfyUI 产线结果；采用前需核对使用范围'},Buffer.concat(chunks));
    await production.recordResult(id,{requestId:`comfy-result-${run.id}-${count}`,batchId:run.batchId,jobId:run.jobId,candidateId:`candidate-${run.id}-${count}`,mediaId:media.mediaId});count++;
   }
   run.state='complete';run.collected=true;await this.projects.connectorRecord(id,{runs});return {state:'complete',candidates:count,snapshot:await this.projects.read(id),notice:'结果仅作为候选，请在生产面板选择采用。'};
  }
  throw new ProjectError('INVALID_CONNECTOR_ACTION','未知连接器操作');
 }
}
