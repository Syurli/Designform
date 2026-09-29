import type { ApiError, CommitRequest, DocumentDraft, ProjectInfo, ProjectSnapshot, RevisionManifest, WorkspaceItem, WorkspaceState } from '../shared/model.ts';
import { isWebEdition } from './edition';
import { connectorSession, connectorRoute, connectorFetch, connectorAssetUrl, prepareConnectorSnapshot, latestConnectorSession } from '../browser/connector';
import { isTransientProject,transientAssetUrls,draftMediaUrls } from '../shared/transient';

let webApi: typeof import('../browser/api') | undefined;
/** 统一提供附件链接：网页端返回本机 Blob，桌面端走受保护的回环接口。 */
export function projectAssetUrl(snapshot: ProjectSnapshot, filename: string) {
  const draft=draftMediaUrls.get(snapshot.project.id+':'+filename);if(draft&&!snapshot.historical)return draft;
  if (isTransientProject(snapshot.project.id)) return transientAssetUrls.get(snapshot.project.id+':'+filename) ?? '';
  if (isWebEdition && connectorSession(snapshot.project.id)) return connectorAssetUrl(snapshot.project.id,filename,snapshot.historical ? snapshot.revision! : 'current');
  if (isWebEdition) return webApi?.browserAssetUrl(snapshot,filename) ?? '';
  return `/api/projects/${snapshot.project.id}/asset?path=${encodeURIComponent(filename)}${snapshot.historical ? `&revision=${encodeURIComponent(snapshot.revision!)}` : ''}`;
}

/** 连接状态只存在当前页面，不能把会话凭证写入公开策划文档。 */
let session = '';
export interface ProjectLibrary { projects: ProjectInfo[]; current: string | null; defaultDirectory: string }
/** 保留结构化冲突详情，编辑器可展示当前磁盘稿而不是吞掉异常。 */
export class ClientError extends Error {
  code: string;
  details?: unknown;
  constructor(error: ApiError) { super(error.message); this.code = error.code; this.details = error.details; }
}

/** 断开时抛错，不伪造成功或静默改用浏览器缓存。 */
export async function request<T>(url: string, input?: unknown, reconnect = true): Promise<T> {
  const temporaryId = /\/api\/projects\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (isTransientProject(temporaryId)) { webApi ??= await import('../browser/api'); return (await import('../browser/transient-projects')).transientApi(url,input) as Promise<T>; }
  const bridge = isWebEdition && connectorRoute(url, input !== undefined);
  if (bridge) { let response: Response; try { response = await connectorFetch(bridge, url, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); } catch { throw new ClientError({code:'OFFLINE',message:'本项目接入服务已断开，请重新启动；页面草稿仍保留。'}); } const result = await response.json(); if (!response.ok || result.error) throw new ClientError(result.error ?? {code:'REQUEST_FAILED',message:'本项目服务未完成请求。'}); return prepareConnectorSnapshot(result as T); }
  if (isWebEdition) {
    try { webApi ??= await import('../browser/api'); return await webApi.browserApi(url,input) as T; }
    catch (error) { const failure = error as Error & { code?: string; details?: unknown }; throw new ClientError({ code: failure.code ?? 'LOCAL_IO_ERROR', message: failure.message, details: failure.details }); }
  }
  let response: Response;
  try { response = await fetch(url, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Cewen-Session': session }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); }
  catch { throw new ClientError({ code: 'OFFLINE', message: '本地服务连接已断开。请启动策问服务后重试，当前输入仍保留在页面中。' }); }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new ClientError({ code: 'SERVICE_UNAVAILABLE', message: '本地项目服务尚未就绪，请稍后重试。' });
  const result = await response.json();
  // 仅在服务明确拒绝执行时重连后重试；网络超时不能推断写入失败。
  if (result?.error?.code === 'SESSION_REQUIRED' && reconnect && url !== '/api/session') { await connectProjects(); return request<T>(url, input, false); }
  if (!response.ok || result?.error) throw new ClientError(result?.error ?? { code: 'REQUEST_FAILED', message: '本地服务没有完成请求。' });
  return result as T;
}
/** 服务重启时可重新连接并继续保留页面草稿。 */
export async function connectProjects(): Promise<ProjectLibrary> {
  if (isWebEdition && latestConnectorSession()) return request<ProjectLibrary>('/api/projects');
  const result = await request<ProjectLibrary & { token: string }>('/api/session');
  session = result.token;
  return result;
}
export const listProjects = () => request<ProjectLibrary>('/api/projects');
/** 连接状态属于应用运行期，不依赖当前项目是否打开。 */
export const readConnections = () => request<import('../shared/model.ts').LlmConnectionState>('/api/connections');
export const readProject = (id: string, verify = false) => request<ProjectSnapshot>(`/api/projects/${encodeURIComponent(id)}${verify ? '?verify=1' : ''}`);
export const createProject = (name: string, kind: 'blank' | 'basic' | 'example', directory: string, setup?: { brief?: string; categories?: import('../shared/model.ts').KnowledgeGroup[] }) => request<ProjectSnapshot>('/api/projects', { name, kind, directory, setup });
export const openProject = (path: string) => request<ProjectSnapshot>('/api/projects/open', { path });
/** 人工保存可合并当前图谱编辑会话；真实提交仍只有同一条受保护的接口。 */
/** 正文编辑器附带实际打开时的文本基准，仅在客户端判断结构草稿冲突。 */
export type UiCommitRequest = CommitRequest & { editingBases?: Record<string,string|null> };
let commitInterceptor: ((value: UiCommitRequest, send: (value: UiCommitRequest) => Promise<ProjectSnapshot>) => Promise<ProjectSnapshot>) | undefined;
export function interceptUserCommits(handler: typeof commitInterceptor) { commitInterceptor=handler; }
export const commitProject = (value: UiCommitRequest): Promise<ProjectSnapshot> => {
  const send=(input: UiCommitRequest)=>{const {editingBases: _editingBases, ...commit}=input;return request<ProjectSnapshot>(`/api/projects/${encodeURIComponent(commit.projectId)}/commit`,commit);};
  return commitInterceptor&&value.actor==='user'?commitInterceptor(value,send):send(value);
};
export const recoverProject = (id: string, direction: 'continue' | 'rollback') => request<ProjectSnapshot>(`/api/projects/${encodeURIComponent(id)}/recover`, { direction });
export const projectHistory = (id: string) => request<{ manifest: RevisionManifest; valid: boolean; problem?: string }[]>(`/api/projects/${encodeURIComponent(id)}/history`);
/** 浏览器应急草稿只在本地保存；服务恢复后仍需正式保存，不能伪称已落盘。 */
export function cacheDraft(id: string, draft: DocumentDraft) { if (isTransientProject(id)) return; try { localStorage.setItem(`cewen-draft:${id}:${draft.id}`, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() })); } catch { /* 容量不足时继续依赖页面离开提醒与文件草稿。 */ } }
export async function projectDrafts(id: string) {
  const values = await request<DocumentDraft[]>(`/api/projects/${encodeURIComponent(id)}/drafts`), drafts = new Map(values.map(draft => [draft.id, draft]));
  if (isTransientProject(id)) return values;
  for (const key of Object.keys(localStorage).filter(key => key.startsWith(`cewen-draft:${id}:`))) { try { const draft = JSON.parse(localStorage.getItem(key)!) as DocumentDraft; if (!drafts.has(draft.id) || draft.updatedAt > drafts.get(draft.id)!.updatedAt) drafts.set(draft.id, draft); } catch { /* 损坏应急副本不替代服务草稿。 */ } }
  return [...drafts.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function saveDraft(id: string, draft: DocumentDraft) { cacheDraft(id, draft); return request<DocumentDraft>(`/api/projects/${encodeURIComponent(id)}/drafts`, draft); }
export async function deleteDraft(id: string, draftId: string) { const result = await request(`/api/projects/${encodeURIComponent(id)}/drafts`, { id: draftId, remove: true }); localStorage.removeItem(`cewen-draft:${id}:${draftId}`); return result; }
export const readRevision = (id: string, revision: string) => request<ProjectSnapshot>(`/api/projects/${encodeURIComponent(id)}/revision?revision=${encodeURIComponent(revision)}`);
export const restorePlan = (id: string, revision: string) => request<CommitRequest>(`/api/projects/${encodeURIComponent(id)}/restore-plan`, { revision });
export const saveBaseline = (id: string, revision: string, name: string) => request(`/api/projects/${encodeURIComponent(id)}/baseline`, { revision, name });
export const readWorkspace = (id: string) => request<WorkspaceState>(`/api/projects/${encodeURIComponent(id)}/workspace`);
export const updateWorkspace = (id: string, update: { baseRevision: number; item?: WorkspaceItem; remove?: string }) => request<WorkspaceState>(`/api/projects/${encodeURIComponent(id)}/workspace`, update);
/** 各业务面板共享会话和错误处理，不再建立第二条直接文件写入通道。 */
export const projectAction = <T>(id: string, action: string, input?: unknown) => request<T>(`/api/projects/${encodeURIComponent(id)}/${action}`, input);

/** 创作模块共享原会话、错误模型和事务服务。 */
export const creativeAction = <T>(id: string, action: string, input: Record<string,unknown> = {}) => projectAction<T>(id,'creative',{...input,action});
export async function loadMediaUrl(snapshot: ProjectSnapshot, filename: string) {
  const draft=draftMediaUrls.get(snapshot.project.id+':'+filename);if(draft&&!snapshot.historical)return draft;
  if (isTransientProject(snapshot.project.id)) return (await import('../browser/transient-projects')).transientMedia(snapshot, filename);
  if (isWebEdition && connectorSession(snapshot.project.id)) return connectorAsset(snapshot, filename);
  if (!isWebEdition) return projectAssetUrl(snapshot,filename);
  webApi ??= await import('../browser/api'); return webApi.loadBrowserMedia(snapshot,filename);
}
export async function uploadProjectMedia(id: string, file: File, input: { requestId: string; permission: string; durationMs?: number }) {
  if(file.size > 64*1024*1024) throw new ClientError({code:'MEDIA_TOO_LARGE',message:'单个媒体文件不能超过 64 MiB'});
  if (isTransientProject(id)) return (await import('../browser/transient-projects')).transientUpload(id,file,input);
  if(isWebEdition && !connectorSession(id)) { webApi ??= await import('../browser/api'); return webApi.uploadBrowserMedia(id,file,{...input,originalName:file.name}); }
  const query=new URLSearchParams({requestId:input.requestId,name:file.name,permission:input.permission,durationMs:String(input.durationMs??0)});
  const bridge = connectorSession(id), route = `/api/projects/${encodeURIComponent(id)}/media-upload?${query}`;
  const options = {method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cewen-Session':session},body:file};
  const response=await (bridge ? connectorFetch(bridge,route,options) : fetch(route,options));
  const result=await response.json();if(!response.ok||result.error)throw new ClientError(result.error??{code:'UPLOAD_FAILED',message:'媒体上传失败'});
  if (bridge && result.snapshot) await prepareConnectorSnapshot(result.snapshot);
  return result as {snapshot:ProjectSnapshot;mediaId:string;duplicate:boolean};
}

/** 长时间排演持有媒体租约，离开时释放；网页缓存只逐出未被使用的 Blob。 */
export async function acquireMediaUrl(snapshot: ProjectSnapshot, filename: string): Promise<{url:string;release:()=>void}> {
  const draft=draftMediaUrls.get(snapshot.project.id+':'+filename);if(draft&&!snapshot.historical)return {url:draft,release:()=>{}};
  if (isTransientProject(snapshot.project.id)) return {url:await loadMediaUrl(snapshot,filename),release:()=>{}};
  if (isWebEdition && connectorSession(snapshot.project.id)) { const url = await connectorAsset(snapshot, filename); return {url,release:()=>URL.revokeObjectURL(url)}; }
  if (!isWebEdition) return {url:projectAssetUrl(snapshot,filename),release:()=>{}};
  webApi ??= await import('../browser/api'); return webApi.acquireBrowserMedia(snapshot,filename);
}
/** 附件通过带会话凭据的 fetch 取为 Blob，避免把令牌写入图片 URL。 */
async function connectorAsset(snapshot: ProjectSnapshot, filename: string) { const bridge = connectorSession(snapshot.project.id)!; const response = await connectorFetch(bridge, `/api/projects/${snapshot.project.id}/asset?path=${encodeURIComponent(filename)}${snapshot.historical ? `&revision=${encodeURIComponent(snapshot.revision!)}` : ''}`); if (!response.ok) throw new ClientError({code:'ASSET_FAILED',message:'本项目附件读取失败。'}); return URL.createObjectURL(await response.blob()); }
export interface ProjectEvent { cursor: number; projectId: string; kind: 'work' | 'project' | 'reset'; taskId?: string }
/** SSE 使用 fetch 以携带会话头，取消订阅会立即中断读取。 */
export function subscribeProjectEvents(id: string, onEvent: (event: ProjectEvent) => void): () => void {
  const controller = new AbortController(); let cursor = 0;
  void (async () => { while (!controller.signal.aborted) { try {
    const route = `/api/projects/${encodeURIComponent(id)}/work-events?cursor=${cursor}`, bridge = connectorSession(id);
    if (isWebEdition && !bridge) return;
    const response = await (bridge ? connectorFetch(bridge,route,{signal:controller.signal}) : fetch(route,{headers:{'X-Cewen-Session':session},signal:controller.signal}));
    if (!response.ok || !response.body) throw new Error('事件连接不可用');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    while (!controller.signal.aborted) { const chunk = await reader.read(); if(chunk.done)break; pending += decoder.decode(chunk.value,{stream:true}); pending = pending.replace(/\r\n/g,'\n'); let split: number; while ((split=pending.indexOf('\n\n'))>=0) { const block=pending.slice(0,split); pending=pending.slice(split+2); const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n'); if(!data)continue; const event=JSON.parse(data) as ProjectEvent; if(event.projectId!==id)continue; cursor=event.cursor; onEvent(event); } }
  } catch { if(controller.signal.aborted)return; } await new Promise(resolve=>setTimeout(resolve,1500)); } })();
  return () => controller.abort();
}
