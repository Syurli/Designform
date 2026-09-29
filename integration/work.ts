import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** 任务通过正在运行的 HTTP 服务执行，适配器不直接读取或写入项目私有存储。 */
interface Client { request<T=unknown>(route:string,input?:unknown):Promise<T> }
/** 连接身份来自当前 stdio 会话，模型不能伪装成另一个连接。 */
interface Presence { id:string; ensure(route:string):Promise<void> }

/** 协作任务的受控登记、增量保存和完成工具，共用服务端原稿保护与文档租约。 */
export function registerWorkTools(server:McpServer,client:Client,presence:Presence){
 const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
 const requestId=z.string().min(1).max(180),generation=z.number().int().min(1);
 const ids=z.array(id).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
 const task={projectId:id,taskId:id,generation};
 /** 工具结果保持结构化文本，不截断失败或伪造保存成功。 */
 const result=async(action:()=>Promise<unknown>)=>{try{const text=JSON.stringify(await action());if(Buffer.byteLength(text)>4*1024*1024)throw new Error('任务结果超过 4 MiB，请明确选择单个任务和所需工作稿。');return {content:[{type:'text' as const,text}]};}catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}};
 /** 首次调用也必须先完成心跳登记，再让服务端验证连接租约。 */
 const post=async(projectId:string,action:string,input:Record<string,unknown>)=>{const route='/api/projects/'+projectId+'/work-'+action;await presence.ensure(route);return client.request(route,{...input,connectionId:presence.id});};
 server.registerTool('cewen_work_begin',{description:'开始用户已经发起的本轮创作或修改。默认先出暂定初稿与关键问题，不把初稿当作用户确认。返回 taskId、generation 和目标序号；只登记明确范围，不提前建固定空文档。之后 documents→write→finish 自动保存，明确要求审核时才用提案。',inputSchema:{projectId:id,requestId,title:z.string().min(1).max(500),documentIds:ids.default([])}},({projectId,...input})=>result(()=>post(projectId,'begin',input)));
 server.registerTool('cewen_work_documents',{description:'按本轮实际内容登记已有 documentId 或新文档标题。软件分配新身份与路径，备份并锁定目标；可选登记分类 groups，不要求固定文档总数。返回每份文档 sequence，后续 write 必须使用最新序号。原始回答和用户决定不可改写。',inputSchema:{...task,requestId,documents:z.array(z.object({documentId:id.optional(),title:z.string().min(1).max(200).optional(),type:z.enum(['gdd','dd','guide','question']).optional(),system:id.optional(),parent:id.optional()})).max(200),groups:z.array(z.object({id,label:z.string().min(1).max(200),color:z.string().regex(/^#[0-9a-f]{6}$/i),parent:id.optional()})).max(60).optional()}},({projectId,...input})=>result(()=>post(projectId,'documents',input)));
 server.registerTool('cewen_work_write',{description:'持久保存已登记目标的工作稿并供工作台查看。replace 写完整正文，append 追加，replace-text 替换唯一 oldText；按 expectedSequence 乐观校验。保留 requestId 用于同内容重试，返回新 sequence。不改身份、用户原始回答、决定记录或历史；不得借此发布未获续轮授权的新问题。',inputSchema:{...task,requestId,documentId:id,mode:z.enum(['replace','append','replace-text']),text:z.string().max(4*1024*1024),oldText:z.string().min(1).max(4*1024*1024).optional(),expectedSequence:z.number().int().min(0)}},({projectId,...input})=>result(()=>post(projectId,'write',input)));
 server.registerTool('cewen_work_finish',{description:'完成本轮工作稿，验证原稿冲突并自动保存公开文档与一次版本。保存暂定初稿不代表用户确认方向或代答。失败保留原稿和工作稿；先读 status，不猜测新的 generation。只有 finish 成功才报告已完成保存。',inputSchema:{...task,dependencies:z.record(z.string(),hash).optional()}},({projectId,...input})=>result(()=>post(projectId,'finish',input)));
 server.registerTool('cewen_work_status',{description:'读取任务状态、generation、目标身份与序号，默认只返回简短摘要。明确提供 taskId 和 includeDrafts=true 才读取该任务恢复稿；不通过空范围读取大量正文。用户停止后不得沿用旧写入权限。',inputSchema:{projectId:id,taskId:id.optional(),includeDrafts:z.boolean().default(false)},annotations:{readOnlyHint:true}},({projectId,taskId,includeDrafts})=>result(async()=>{
  if(includeDrafts&&!taskId)throw new Error('读取工作稿请明确提供 taskId，避免空范围读取所有正文。');
  const query=new URLSearchParams();if(taskId)query.set('taskId',taskId);if(includeDrafts)query.set('includeDrafts','1');
  const route='/api/projects/'+projectId+'/work-status'+(query.size?'?'+query.toString():'');await presence.ensure(route);const data=await client.request<Record<string,unknown>>(route);
  // 服务端状态用于 UI 投影时可能包含正文；工具默认再次剔除，避免无意传出大工作稿。
  if(!includeDrafts&&Array.isArray(data.documents))return {...data,documents:data.documents.map((value:Record<string,unknown>)=>({id:value.id,title:value.title,path:value.path,sequence:value.sequence,hash:value.hash,isNew:value.isNew,taskId:value.taskId}))};
  return data;
 }));
 server.registerTool('cewen_work_control',{description:'取消自己的任务或在用户明确要求恢复时恢复停止/失败任务。重试沿用相同 requestId，避免重复取消已经恢复的任务。恢复返回新的 generation，旧写入必须停止。取消保留原稿与工作稿，不代替用户撤销已完成修改；不得因仍有 MCP 心跳自行恢复用户停止的任务。',inputSchema:{projectId:id,taskId:id,requestId,action:z.enum(['cancel','resume'])}},({projectId,...input})=>result(()=>post(projectId,'control',input)));
}
