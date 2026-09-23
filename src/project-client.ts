import type { ApiError, CommitRequest, DocumentDraft, ProjectInfo, ProjectSnapshot, RevisionManifest, WorkspaceItem, WorkspaceState } from '../shared/model.ts';
import { isWebEdition } from './edition';

let webApi: typeof import('../browser/api') | undefined;
/** 统一提供附件链接：网页端返回本机 Blob，桌面端走受保护的回环接口。 */
export function projectAssetUrl(snapshot: ProjectSnapshot, filename: string) {
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
export function cacheDraft(id: string, draft: DocumentDraft) { try { localStorage.setItem(`cewen-draft:${id}:${draft.id}`, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() })); } catch { /* 容量不足时继续依赖页面离开提醒与文件草稿。 */ } }
export async function projectDrafts(id: string) {
  const values = await request<DocumentDraft[]>(`/api/projects/${encodeURIComponent(id)}/drafts`), drafts = new Map(values.map(draft => [draft.id, draft]));
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
