/** 策问公开文档格式；格式号独立于应用发行版本和接口协议。 */
export const DOCUMENT_FORMAT = 1;
/** 文件交换与本地接口共用的协议号。 */
export const PROTOCOL_VERSION = 1;

/** 运行期连接信息不进入项目正文、版本或私人工作区。模型名称由客户端明确提供。 */
export interface LlmConnection {
  id: string;
  clientName: string;
  clientVersion: string;
  modelName: string;
  modelSource: 'configured' | 'reported' | 'unknown';
  transport: 'mcp';
  connectedAt: string;
  lastSeenAt: string;
  lastActivityAt?: string;
  projectId?: string;
  status: 'connected' | 'disconnected';
}
export interface LlmConnectionState { connections: LlmConnection[]; heartbeatTimeoutMs: number }

/** 文档中的设计状态；与来源充分程度及工程实现状态无关。 */
export type DesignStatus = 'draft' | 'question' | 'confirmed' | 'archived';
/** 知识空间的三个阅读层次；问题通过状态和文档类型表达。 */
export type NodeKind = 'system' | 'document' | 'rule';
/** 正式关系种类；包含关系从公开文档结构派生，不能自由制造归属环。 */
export type RelationType = 'contains' | 'depends' | 'constrains' | 'relates' | 'references' | 'replaces';
/** 系统数量与身份由项目决定，不限制为原型中的五个分组。 */
export type GroupId = string;

/** 系统目录的公开语义；配色是展示提示，不代表设计状态。 */
export interface KnowledgeGroup {
  id: GroupId;
  label: string;
  color: string;
}

/** 图谱节点是 Markdown 的读取投影，不是另一份可单独修改的正文。 */
export interface KnowledgeNode {
  id: string;
  title: string;
  group: GroupId;
  kind: NodeKind;
  summary: string;
  content: string[];
  source: string;
  status: DesignStatus;
  /** 对应的公开文档身份；规则 ID 使用“文档 ID / 锚点”组合。 */
  documentId: string;
  /** 相对项目根目录的位置，绝不依赖开发者电脑路径。 */
  documentPath: string;
  /** 规则在 Markdown 中的稳定锚点；文档和系统节点可省略。 */
  anchor?: string;
  /** 文档类型来自 Markdown 头部，用于识别总纲；不按标题猜测核心。 */
  documentType?: ProjectDocument['type'];
  /** 条目自定义颜色；未设置时由所属分类决定。 */
  color?: string;
}

/** 边有独立稳定 ID；数组位置只允许作为当前绘图帧的临时索引。 */
export interface KnowledgeEdge {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  note: string;
  /** 修改关系时精确定位其公开来源；不把派生关系误当手工关系删除。 */
  origin?: { kind: 'classification' | 'section' | 'catalog' | 'manual' | 'markdown' | 'question'; path: string; occurrences?: { start: number; end: number; label: string; url: string; reference: boolean }[] };
}

/** 各视图共用的中文关系图例。 */
export interface RelationLegend { id: RelationType; label: string; color: string }
export const relationTypes: RelationLegend[] = [
  { id: 'contains', label: '包含', color: '#8B8176' },
  { id: 'depends', label: '依赖', color: '#5F91B9' },
  { id: 'constrains', label: '约束', color: '#BD7764' },
  { id: 'relates', label: '关联', color: '#A289BA' },
  { id: 'references', label: '引用', color: '#7FADA7' },
  { id: 'replaces', label: '替代', color: '#B9A36C' },
];

/** 项目说明来自 PROJECT.md；路径只由本地项目服务补入。 */
export interface ProjectInfo {
  id: string;
  name: string;
  description: string;
  format: number;
  path: string;
  isExample: boolean;
  /** 项目身份图标随 PROJECT.md 公开保存。 */
  icon?: { kind: 'text' | 'symbol' | 'image'; value: string };
  /** 可留空的项目共享备注。 */
  notes?: string;
}

/** 解析诊断只描述实际问题，不在读取时自动重写用户文件。 */
export interface Diagnostic {
  code: string;
  severity: 'warning' | 'error';
  path: string;
  message: string;
  line?: number;
}

/** 文件读取结果保留全文与哈希，编辑和冲突比较始终以原文为基础。 */
export interface ProjectDocument {
  id: string;
  path: string;
  title: string;
  type: 'gdd' | 'dd' | 'question' | 'guide';
  status: DesignStatus;
  system: string;
  text: string;
  hash: string;
  /** 文档自定义颜色；未设置时继承分类色。 */
  color?: string;
}

/** 所有知识空间组件接收同一个显式数据对象。 */
export interface KnowledgeData {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  groups: KnowledgeGroup[];
  /** 项目级公开分类的修改基准，不要求用户在总纲正文维护目录字段。 */
  projectEntry?: { text: string; hash: string };
}

/** 当前磁盘投影；有诊断时仍保留可读原文，不伪称同步无误。 */
export interface ProjectSnapshot extends KnowledgeData {
  project: ProjectInfo;
  documents: ProjectDocument[];
  diagnostics: Diagnostic[];
  /** 最后一个完整公开版本；空项目尚未提交时允许为空。 */
  revision: string | null;
  /** 当前公开文件内容清单的指纹，用于发现外部修改。 */
  fingerprint: string;
  /** 是否存在尚未完成、需要恢复的本地提交。 */
  recoveryRequired: boolean;
  /** 历史快照只读，所有阅读视图使用同一修订来源。 */
  historical?: boolean;
  revisionLabel?: string;
  /** 公开文件清单用于附件和完整恢复的并发校验。 */
  files?: Record<string, string>;
  /** 受控公开排版和笔画文件；不作为 Markdown 正文解析。 */
  companions?: Record<string, { text: string; hash: string }>;
}

/** 单个文件的乐观写入约束；null 表示创建且目标必须不存在。 */
export interface FileChange {
  path: string;
  baseHash: string | null;
  text: string | null;
  /** 仅附件允许 base64；Markdown 始终使用普通 UTF-8 文本。 */
  encoding?: 'base64';
}

/** 保存、导入、恢复和模型采纳共享的文件批次。 */
export interface CommitRequest {
  projectId: string;
  requestId: string;
  baseRevision: string | null;
  reason: string;
  actor: 'user' | 'external' | 'import' | 'restore' | 'llm';
  changes: FileChange[];
  /** 被本次设计决定依赖但不直接修改的文件也需核对哈希。 */
  dependencies?: Record<string, string>;
  /** 恢复来源独立于父修订，不能截断既有历史。 */
  restoredFrom?: string;
}

/** 公开版本清单是历史验证依据；完整快照不依赖 SQLite。 */
export interface RevisionManifest {
  format: number;
  state: 'complete';
  projectId: string;
  id: string;
  label: string;
  parent: string | null;
  createdAt: string;
  actor: CommitRequest['actor'];
  reason: string;
  requestId: string;
  /** 同一个请求 ID 携带不同内容时必须拒绝，不能误当作成功重试。 */
  requestHash: string;
  files: Record<string, string>;
  fingerprint: string;
  changedPaths: string[];
  restoredFrom?: string;
  /** 完整快照文件总字节数，便于展示历史占用。 */
  bytes?: number;
}

/** 工作集合和批注属于编辑器数据，不能混进游戏设计正文。 */
export interface WorkspaceItem {
  id: string;
  kind: 'collection' | 'annotation' | 'marker' | 'view' | 'proposal';
  title: string;
  scope: 'project' | 'personal';
  targets: string[];
  text: string;
  tags: string[];
  state: string;
  parent?: string;
  order?: number;
  excerpt?: string;
  payload?: unknown;
  /** 提案原稿保持不变，逐文件采纳进度独立记录。 */
  appliedFiles?: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}
/** 按记录版本进行并发更新，避免多个窗口覆盖彼此的批注。 */
export interface WorkspaceState { revision: number; items: WorkspaceItem[] }

/** 人和模型共用的提案包；采纳动作只由工作台发起。 */
export interface Proposal {
  id: string;
  title: string;
  reason: string;
  baseRevision: string;
  changes: FileChange[];
  dependencies: Record<string, string>;
  questionIds: string[];
}

/** 服务错误始终结构化返回，前端与 CLI 不依赖解析英文异常。 */
export interface ApiError { code: string; message: string; details?: unknown }

/** 每个编辑窗口独立草稿，不能互相覆盖未提交输入。 */
export interface DocumentDraft {
  id: string;
  /** 问询表单草稿不能误当成 Markdown 编辑草稿。 */
  purpose?: 'document' | 'answers' | 'graph';
  documentPath: string;
  baseHash: string | null;
  baseText: string | null;
  text: string;
  updatedAt: string;
  /** 新稿附件跟随私人草稿，正式保存时与正文一起提交。 */
  assets?: { path: string; text: string; encoding: 'base64' }[];
  /** 图谱编辑会话恢复包仍是私人草稿，正式内容提交使用普通文件批次。 */
  changes?: FileChange[];
  /** 同一编辑会话尚未提交的公开伴随文件更改，仍保存在私人草稿中。 */
  companions?: FileChange[];
  baseRevision?: string | null;
}
