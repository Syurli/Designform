import type { ProjectDocument, ProjectSnapshot } from './model.ts';

/** 协作任务与连接分开记录；客户端在线不代表模型仍在编写。 */
export type WorkTaskStatus = 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
/** 可以公开给工作台及模型的任务摘要，不含任务写入凭据或个人草稿。 */
export interface WorkTaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: WorkTaskStatus;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
  documentIds: string[];
  generation: number;
  error?: string;
  revision?: string | null;
}
/** 工作稿仅是受控阅读投影，正式文档哈希仍由独立快照维护。 */
export interface WorkDocumentProjection extends ProjectDocument {
  taskId: string;
  sequence: number;
  isNew: boolean;
}
/** 文档锁由服务端执行，用户阅读锁不能覆盖此状态。 */
export interface WorkDocumentLock { taskId: string; connectionId: string }
/** 当前项目的协作投影；恢复工作稿只向明确请求该任务的接口返回。 */
export interface CollaborationState {
  tasks: WorkTaskSummary[];
  locks: Record<string, WorkDocumentLock>;
  documents: WorkDocumentProjection[];
  cursor: number;
}
/** 事件只通知发生变化，客户端按游标刷新快照，不广播私人正文。 */
export interface CollaborationEvent { cursor: number; projectId: string; kind: 'work' | 'project' | 'reset'; taskId?: string }
/** 新任务可先声明已有目标，随后按需要扩充，不要求提前决定文档总数。 */
export interface WorkBeginInput { requestId: string; title: string; documentIds?: string[] }
/** 新文档默认是草稿；路径和稳定身份由软件分配。 */
export interface WorkDocumentInput { documentId?: string; title?: string; type?: ProjectDocument['type']; system?: string; parent?: string }
/** 追加与精确替换降低 token 成本；替换目标不唯一时拒绝猜测。 */
export interface WorkWriteInput {
  taskId: string; generation: number; requestId: string; documentId: string;
  mode: 'replace' | 'append' | 'replace-text'; text: string; oldText?: string; expectedSequence: number;
}
/** 正式快照不被工作稿修改；UI 需要展示时显式叠加受控投影。 */
export function projectWorkView(snapshot: ProjectSnapshot): ProjectSnapshot {
  const work = snapshot.collaboration;
  if (!work?.documents.length || snapshot.historical) return snapshot;
  const documents = new Map(snapshot.documents.map(document => [document.id, document]));
  for (const document of work.documents) documents.set(document.id, document);
  return { ...snapshot, documents: [...documents.values()] };
}
