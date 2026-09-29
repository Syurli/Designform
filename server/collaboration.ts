import { stringify } from 'yaml';
import type { ProjectService } from './projects.ts';
import type { CommitRequest, KnowledgeGroup, ProjectDocument, ProjectSnapshot } from '../shared/model.ts';
import type { CollaborationEvent, CollaborationState, WorkBeginInput, WorkDocumentInput, WorkDocumentProjection, WorkTaskSummary, WorkWriteInput } from '../shared/collaboration.ts';
import { Buffer, randomUUID, runtimePid, ownerAlive } from './platform.ts';
import { optionalBytes, ProjectError, sha256, writeBytes } from './files.ts';
import { history } from './history.ts';
import { readHeader, parseKnowledge } from '../shared/markdown.ts';
import { questionDocument, setMetadata } from '../shared/editing.ts';
import { section } from '../shared/inquiry.ts';

/** 正式提交前的持久任务记录。原稿与工作稿独立保存，不进入普通上下文。 */
interface StoredDocument { original: ProjectDocument | null; current: WorkDocumentProjection; dependencies: Record<string, string | null>; }
interface StoredTask extends WorkTaskSummary {
  requestId: string; beginHash: string; baseRevision: string | null; instance: string; pid: number;
  lastProgress: number; leaseUntil: number; documents: StoredDocument[]; groups: KnowledgeGroup[];
  operations: Record<string, { hash: string; result: unknown }>;
  finishRequest?: CommitRequest; undoRequest?: CommitRequest; dismissed?: boolean; undone?: boolean;
}
interface Store { format: 1; projectId: string; tasks: StoredTask[] }
type Permit = { taskId: string; generation: number; connectionId: string };
const STORE_PATH = '.cewen/collaboration/tasks.json';
const IDLE_MS = 10 * 60 * 1000;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const nowText = () => new Date().toISOString();

/** 一组长期文档租约配合短项目事务；模型生成期间不会持有整个项目文件锁。 */
export class CollaborationService {
  private readonly instance = randomUUID();
  private readonly projects = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(event: CollaborationEvent) => void>>();
  private readonly events = new Map<string, CollaborationEvent[]>();
  private sequence = Date.now() * 1000;
  private timer: ReturnType<typeof setInterval>;

  constructor(private service: ProjectService, private connected: (id: string) => boolean) {
    service.setCollaborationGuard((id, paths, permit) => this.guard(id, paths, permit), id => this.emit(id, 'project'), () => this.close());
    this.timer = setInterval(() => { for (const id of this.projects) void this.maintain(id).catch(() => {}); }, 10000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); this.listeners.clear(); }

  /** 任务控制按项目顺序处理；正式提交仍复用 ProjectService 的文件级冲突校验。 */
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.projects.add(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  private emit(projectId: string, kind: CollaborationEvent['kind'] = 'work', taskId?: string) {
    const event: CollaborationEvent = { cursor: ++this.sequence, projectId, kind, ...(taskId ? { taskId } : {}) };
    const events = this.events.get(projectId) ?? []; events.push(event); if (events.length > 256) events.shift(); this.events.set(projectId, events);
    for (const listener of this.listeners.get(projectId) ?? []) listener(event);
  }
  /** 游标过期或服务重启时发送 reset；调用方重新取得正式快照和工作稿投影。 */
  subscribe(id: string, cursor: number, callback: (event: CollaborationEvent) => void) {
    const events = this.events.get(id) ?? [];
    if (!cursor || !events.length || cursor < events[0].cursor || cursor > this.sequence) callback({ cursor: this.sequence, projectId: id, kind: 'reset' });
    else for (const event of events) if (event.cursor > cursor) callback(event);
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(callback); this.listeners.set(id, listeners);
    return () => { listeners.delete(callback); if (!listeners.size) this.listeners.delete(id); };
  }

  /** 每次短事务重新读取记录，避免其他宿主的任务锁被旧内存覆盖。 */
  private async load(root: string, projectId: string): Promise<Store> {
    const bytes = await optionalBytes(root, STORE_PATH);
    if (!bytes) return { format: 1, projectId, tasks: [] };
    let value: Store;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ProjectError('WORK_STORE_DAMAGED', '协作任务记录损坏，已保留原稿并停止写入。'); }
    if (value.format !== 1 || value.projectId !== projectId || !Array.isArray(value.tasks) || value.tasks.some(task => !safeId.test(task.id) || !Array.isArray(task.documents) || !task.operations || !Array.isArray(task.groups))) throw new ProjectError('WORK_STORE_DAMAGED', '协作任务身份或结构不正确，请保留项目并处理恢复。');
    let changed = false;
    for (const task of value.tasks) {
      // 正式提交成功后进程退出的窄窗口，以可信版本记录完成状态，而不重复发布。
      if (task.status !== 'completed' && task.finishRequest) {
        const committed = (await history(root, projectId)).find(entry => entry.valid && entry.manifest.requestId === task.finishRequest!.requestId);
        if (committed) { task.status = 'completed'; task.revision = committed.manifest.id; task.updatedAt = nowText(); changed = true; continue; }
      }
      if (task.status !== 'running') continue;
      const deadOwner = task.instance !== this.instance && (!ownerAlive(task.pid) || task.leaseUntil < Date.now());
      const ownDisconnected = task.instance === this.instance && !this.connected(task.connectionId) && task.leaseUntil < Date.now();
      if (deadOwner || ownDisconnected || Date.now() - task.lastProgress > IDLE_MS) {
        task.status = 'interrupted'; task.error = Date.now() - task.lastProgress > IDLE_MS ? '十分钟没有任务进展，工作稿已保留。' : '协作连接已中断，工作稿已保留。';
        task.generation++; task.updatedAt = nowText(); changed = true;
      }
    }
    if (changed) { await this.save(root, value); this.emit(projectId); }
    return value;
  }
  private save(root: string, value: Store) { return writeBytes(root, STORE_PATH, JSON.stringify(value)); }
  private summary(task: StoredTask): WorkTaskSummary {
    const { id, projectId, title, status, connectionId, createdAt, updatedAt, documentIds, generation, error, revision } = task;
    return { id, projectId, title, status, connectionId, createdAt, updatedAt, documentIds, generation, ...(error ? { error } : {}), ...(revision !== undefined ? { revision } : {}) };
  }
  private state(store: Store): CollaborationState {
    const tasks = store.tasks.filter(task => !task.dismissed).slice(-100);
    const active = store.tasks.filter(task => task.status === 'running');
    return { tasks: tasks.map(task => this.summary(task)), locks: Object.fromEntries(active.flatMap(task => task.documentIds.map(id => [id, { taskId: task.id, connectionId: task.connectionId }]))), documents: active.flatMap(task => task.documents.map(document => document.current)), cursor: this.sequence };
  }
  async status(id: string, taskId?: string, includeDrafts = false) {
    return this.serial(id, () => this.service.collaborationExclusive(id, async root => {
      const store = await this.load(root, id);
      if (!taskId) { const state = this.state(store); return includeDrafts ? state : { ...state, documents: [] }; }
      const task = this.find(store, taskId);
      return { ...this.summary(task), documents: task.documents.map(({ current }) => includeDrafts ? current : { id: current.id, title: current.title, path: current.path, sequence: current.sequence, hash: current.hash, isNew: current.isNew }) };
    }));
  }
  async decorate(snapshot: ProjectSnapshot) {
    if (!snapshot.historical) snapshot.collaboration = await this.status(snapshot.project.id, undefined, true) as CollaborationState;
    return snapshot;
  }
  private async maintain(id: string) {
    return this.serial(id, () => this.service.collaborationExclusive(id, async root => {
      const store = await this.load(root, id); let changed = false;
      for (const task of store.tasks) if (task.status === 'running' && task.instance === this.instance && this.connected(task.connectionId)) { task.leaseUntil = Date.now() + 35000; changed = true; }
      if (changed) await this.save(root, store);
    }));
  }
  private find(store: Store, id: string) { const task = store.tasks.find(task => task.id === id); if (!task) throw new ProjectError('WORK_NOT_FOUND', '协作任务不存在。'); return task; }
  private requireConnection(connectionId: string) { if (!connectionId || !this.connected(connectionId)) throw new ProjectError('WORK_CONNECTION_REQUIRED', '请先建立真实 MCP 连接，再开始或恢复协作。'); }
  private writable(store: Store, permit: Permit) {
    const task = this.find(store, permit.taskId);
    this.requireConnection(permit.connectionId);
    if (task.status !== 'running' || task.generation !== permit.generation || task.connectionId !== permit.connectionId || task.instance !== this.instance) throw new ProjectError('WORK_STALE_OWNER', '任务已停止、换连接或恢复，请重新读取任务状态，旧写入已拒绝。');
    return task;
  }
  private stable(snapshot: ProjectSnapshot) {
    if (snapshot.recoveryRequired || snapshot.diagnostics.some(issue => issue.severity === 'error' || ['FILES_CHANGING', 'EXTERNAL_BATCH_OPEN'].includes(issue.code))) throw new ProjectError('WORK_PROJECT_UNSTABLE', '项目需要先处理恢复或文件问题，尚未开始修改。', snapshot.diagnostics);
  }
  private operation(task: StoredTask, requestId: string, input: unknown) {
    if (!requestId || requestId.length > 180 || Object.keys(task.operations).length > 10000) throw new ProjectError('INVALID_REQUEST', '任务操作需要有效请求身份，或本轮操作已过多。');
    const hash = sha256(JSON.stringify(input)), old = task.operations[requestId];
    if (old && old.hash !== hash) throw new ProjectError('IDEMPOTENCY_MISMATCH', '同一任务操作身份不能用于不同内容。');
    return { hash, old };
  }
  private progress(task: StoredTask) { task.updatedAt = nowText(); task.lastProgress = Date.now(); task.leaseUntil = Date.now() + 35000; delete task.error; }

  /** 所有正式提交入口共用此检查。模型只可提交其仍然持有的目标，人工不能抢占。 */
  private async guard(id: string, paths: string[], permit?: Permit) {
    const root = await this.service.collaborationRoot(id), store = await this.load(root, id);
    const own = permit ? this.writable(store, permit) : undefined;
    // 缺失的伴随文件也是依赖，防止生成期间有人在外部新建同名布局后被误当作原稿。
    if (own) for (const document of own.documents) for (const [path, expected] of Object.entries(document.dependencies)) {
      const bytes = await optionalBytes(root, path);
      if ((bytes ? sha256(bytes) : null) !== expected) throw new ProjectError('WORK_BASE_CONFLICT', '原稿或伴随文件已经变化，请比较后恢复任务。', { path });
    }
    for (const task of store.tasks) if (task.status === 'running') {
      const protectedPaths = task.documents.flatMap(document => this.documentPaths(document.current));
      const touched = paths.some(path => path === '*' || path === 'PROJECT.md' && !own || protectedPaths.some(target => target.toLowerCase() === path.toLowerCase()));
      if (touched && own?.id !== task.id) throw new ProjectError('DOCUMENT_LOCKED', '文档正在由 LLM 编写，暂时只读；可停止任务后编辑。', { taskId: task.id, documentIds: task.documentIds });
    }
    if (own && paths.some(path => path !== 'PROJECT.md' && !own.documents.some(document => document.current.path === path))) throw new ProjectError('WORK_TARGET_DENIED', '任务不能写入未登记的文档。');
  }
  private documentPaths(document: ProjectDocument) { return [document.path, `docs/layouts/${document.id}.json`, `docs/annotations/${document.id}.ink.json`, `docs/annotations/${document.id}.md`]; }

  async begin(id: string, connectionId: string, input: WorkBeginInput) {
    this.requireConnection(connectionId);
    // 首次读取建立空项目的初始版本；任务私有草稿不参与外部变更扫描。
    await this.service.read(id);
    return this.serial(id, () => this.service.collaborationExclusive(id, async (root, snapshot) => {
      this.stable(snapshot);
      if (!input.requestId || input.requestId.length > 180 || !input.title?.trim() || input.title.length > 500 || (input.documentIds?.length ?? 0) > 200) throw new ProjectError('INVALID_REQUEST', '请输入任务说明和有效请求身份。');
      const store = await this.load(root, id), beginHash = sha256(JSON.stringify(input)), previous = store.tasks.find(task => task.requestId === input.requestId && task.connectionId === connectionId);
      if (previous) { if (previous.beginHash !== beginHash) throw new ProjectError('IDEMPOTENCY_MISMATCH', '本次任务身份已用于另一项工作。'); return this.receipt(previous); }
      if (store.tasks.length >= 1000) throw new ProjectError('WORK_LIMIT', '本项目任务记录已达上限，请先归档项目。');
      const task: StoredTask = { id: `work-${randomUUID()}`, projectId: id, title: input.title.trim(), status: 'running', connectionId, createdAt: nowText(), updatedAt: nowText(), documentIds: [], generation: 1, requestId: input.requestId, beginHash, baseRevision: snapshot.revision, instance: this.instance, pid: runtimePid, lastProgress: Date.now(), leaseUntil: Date.now() + 35000, documents: [], groups: [], operations: {} };
      await this.addDocuments(root, snapshot, store, task, (input.documentIds ?? []).map(documentId => ({ documentId })));
      store.tasks.push(task); await this.save(root, store); this.emit(id, 'work', task.id);
      return { ...this.receipt(task), project: { id, name: snapshot.project.name, revision: snapshot.revision, groups: snapshot.groups }, documents: task.documents.map(document => this.documentReceipt(document.current)) };
    }));
  }
  private receipt(task: StoredTask) { return { taskId: task.id, generation: task.generation, status: task.status, documentIds: task.documentIds, ...(task.revision !== undefined ? { revision: task.revision } : {}) }; }
  private documentReceipt(document: WorkDocumentProjection) { return { documentId: document.id, title: document.title, path: document.path, sequence: document.sequence, isNew: document.isNew, hash: document.hash }; }

  /** 每个追加目标在成功登记前完成原稿备份，所有新路径由软件生成。 */
  private async addDocuments(root: string, snapshot: ProjectSnapshot, store: Store, task: StoredTask, inputs: WorkDocumentInput[]) {
    if (!Array.isArray(inputs) || inputs.length > 200 || task.documents.length + inputs.length > 200) throw new ProjectError('INVALID_REQUEST', '一次任务最多处理 200 份文档。');
    for (const input of inputs) {
      if (!input || typeof input !== 'object') throw new ProjectError('INVALID_DOCUMENT', '文档登记项格式不正确。');
      if (input.documentId && task.documents.some(document => document.current.id === input.documentId)) continue;
      const original = input.documentId ? snapshot.documents.find(document => document.id === input.documentId) : undefined;
      if (input.documentId && !original) throw new ProjectError('MISSING_DOCUMENT', '待修改文档不存在，请先核对文档身份。');
      if (original && (!safeId.test(original.id) || !original.path.startsWith('docs/') || ['docs/README.md', 'docs/INDEX.md'].includes(original.path))) throw new ProjectError('WORK_TARGET_DENIED', '请选择具有稳定身份的正式设计文档。');
      const owner = store.tasks.find(other => other.status === 'running' && other.id !== task.id && other.documents.some(document => document.current.id === original?.id));
      if (owner) throw new ProjectError('DOCUMENT_LOCKED', '此文档已有任务在编写，可先处理其他文档。', { taskId: owner.id, documentId: original!.id });
      const type = input.type ?? 'dd', title = input.title?.trim();
      if (!original && (!title || title.length > 200 || !['gdd', 'dd', 'guide', 'question'].includes(type))) throw new ProjectError('INVALID_DOCUMENT', '新文档需要标题和有效类型。');
      const documentId = original?.id ?? `${type}-${randomUUID()}`;
      const filename = original?.path ?? `docs/${type === 'question' ? 'questions' : type === 'gdd' ? 'gdd' : 'dd'}/${documentId}.md`;
      if (!original && Object.keys(snapshot.files ?? {}).some(path => path.toLowerCase() === filename.toLowerCase())) throw new ProjectError('PATH_EXISTS', '新文档路径已经存在。');
      const text = original?.text ?? (type === 'question' ? questionDocument({ id: documentId, title: title!, background: '正在整理关键问题。', options: [], targets: [], revision: snapshot.revision }) : `---\n${stringify({ id: documentId, type, status: 'draft', ...(input.system ? { system: input.system } : {}), ...(input.parent ? { parent: input.parent } : {}) })}---\n\n# ${title!.replace(/[\r\n]/g, ' ')}\n\n正在编写。\n`);
      const current: WorkDocumentProjection = { ...(original ?? { id: documentId, path: filename, title: title!, type, status: 'draft', system: input.system ?? '', ...(input.parent ? { parent: input.parent } : {}), text, hash: sha256(text) }), taskId: task.id, sequence: 0, isNew: !original };
      const dependencies: Record<string, string | null> = {};
      for (const path of this.documentPaths(current)) {
        const bytes = await optionalBytes(root, path);
        dependencies[path] = bytes ? sha256(bytes) : null;
        if (bytes) await writeBytes(root, `.cewen/collaboration/${task.id}/before/${path}`, bytes);
      }
      task.documents.push({ original: original ?? null, current, dependencies }); task.documentIds.push(documentId);
    }
  }
  async documents(id: string, connectionId: string, input: { taskId: string; generation: number; requestId: string; documents: WorkDocumentInput[]; groups?: KnowledgeGroup[] }) {
    return this.serial(id, () => this.service.collaborationExclusive(id, async (root, snapshot) => {
      const store = await this.load(root, id), task = this.writable(store, { ...input, connectionId });
      const operation = this.operation(task, input.requestId, input); if (operation.old) return operation.old.result;
      if (task.finishRequest) throw new ProjectError('WORK_FINISH_PENDING', '任务已有待核对的正式提交，请先完成或恢复。');
      this.stable(snapshot);
      if (input.groups) {
        if (!Array.isArray(input.groups) || input.groups.length > 60 || input.groups.some(group => !safeId.test(group.id) || !group.label?.trim() || !/^#[0-9a-f]{6}$/i.test(group.color) || group.parent && !safeId.test(group.parent))) throw new ProjectError('INVALID_SYSTEM', '分类需要稳定身份、中文名称和有效颜色。');
        if (!task.groups.length && snapshot.projectEntry) await writeBytes(root, `.cewen/collaboration/${task.id}/before/PROJECT.md`, snapshot.projectEntry.text);
        for (const group of input.groups) { const existing = task.groups.find(item => item.id === group.id); if (existing && JSON.stringify(existing) !== JSON.stringify(group)) throw new ProjectError('GROUP_CONFLICT', '本轮已经声明同身份的不同分类。'); if (!existing) task.groups.push(group); }
      }
      await this.addDocuments(root, snapshot, store, task, input.documents);
      this.progress(task); const result = { ...this.receipt(task), documents: task.documents.map(document => this.documentReceipt(document.current)) };
      task.operations[input.requestId] = { hash: operation.hash, result }; await this.save(root, store); this.emit(id, 'work', task.id); return result;
    }));
  }

  /** 原始回答和用户决定保持独立；自由正文写入不能成为模型代答通道。 */
  private protectQuestion(document: StoredDocument, text: string) {
    if (document.current.type !== 'question') return;
    const original = document.original?.text ?? document.current.text;
    for (const heading of ['用户原始回答', '决定记录']) if (section(text, heading).text !== section(original, heading).text) throw new ProjectError('USER_ANSWER_PROTECTED', `模型不能新增或改写“${heading}”。`);
  }
  async write(id: string, connectionId: string, input: WorkWriteInput) {
    return this.serial(id, () => this.service.collaborationExclusive(id, async root => {
      const store = await this.load(root, id), task = this.writable(store, { ...input, connectionId });
      const operation = this.operation(task, input.requestId, input); if (operation.old) return operation.old.result;
      if (task.finishRequest) throw new ProjectError('WORK_FINISH_PENDING', '任务已有待核对提交，请先处理恢复。');
      const document = task.documents.find(item => item.current.id === input.documentId);
      if (!document) throw new ProjectError('WORK_TARGET_DENIED', '请先登记目标文档，软件会自动备份并锁定。');
      if (input.expectedSequence !== document.current.sequence) throw new ProjectError('WORK_SEQUENCE_CONFLICT', '工作稿已经更新，请读取任务状态后续写。', this.documentReceipt(document.current));
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 4 * 1024 * 1024) throw new ProjectError('DOCUMENT_TOO_LARGE', '请分段提交正文，单份文档最多 4 MiB。');
      let text: string;
      if (input.mode === 'replace') {
        text = input.text;
        if (!/^---\r?\n/.test(text)) text = `---\n${stringify(readHeader(document.current.text).metadata)}---\n\n${/^#\s/m.test(text) ? '' : `# ${document.current.title}\n\n`}${text}`;
      } else if (input.mode === 'append') text = document.current.text + input.text;
      else if (input.mode === 'replace-text') {
        const old = input.oldText;
        if (!old || document.current.text.indexOf(old) < 0 || document.current.text.indexOf(old) !== document.current.text.lastIndexOf(old)) throw new ProjectError('WORK_REPLACEMENT_AMBIGUOUS', '替换片段必须存在且唯一，请先读取工作稿。');
        text = document.current.text.replace(old, () => input.text);
      } else throw new ProjectError('INVALID_REQUEST', '不支持这种工作稿写入方式。');
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new ProjectError('DOCUMENT_TOO_LARGE', '工作稿超过 4 MiB，请合理拆分文档。');
      const metadata = readHeader(text).metadata;
      if (metadata.id !== document.current.id || metadata.type !== document.current.type) throw new ProjectError('WORK_IDENTITY_CHANGED', '续写不能改变已登记文档的身份或类型。');
      this.protectQuestion(document, text);
      const parsed = parseKnowledge([{ path: document.current.path, text, hash: sha256(text) }]).documents.find(item => item.id === document.current.id);
      document.current = { ...document.current, ...(parsed ?? {}), text, hash: sha256(text), sequence: document.current.sequence + 1 };
      this.progress(task); const result = { ...this.documentReceipt(document.current), taskId: task.id, generation: task.generation };
      task.operations[input.requestId] = { hash: operation.hash, result }; await this.save(root, store); this.emit(id, 'work', task.id); return result;
    }));
  }

  /** 分类按最新入口合并新增项，多个任务独立新增分类不会因项目版本前进而冲突。 */
  private buildCommit(snapshot: ProjectSnapshot, task: StoredTask, dependencies: Record<string, string> = {}): CommitRequest {
    if (!task.documents.length || task.documents.some(document => document.current.isNew && document.current.sequence === 0)) throw new ProjectError('WORK_INCOMPLETE', '请先完成新文档正文，不能发布仍未编写的占位。');
    const changes = task.documents.map(document => ({ path: document.current.path, baseHash: document.original?.hash ?? null, text: document.current.text }));
    const allDependencies = { ...dependencies };
    for (const document of task.documents) for (const [path, hash] of Object.entries(document.dependencies)) if (path !== document.current.path && hash !== null) allDependencies[path] = hash;
    if (task.groups.length) {
      if (!snapshot.projectEntry) throw new ProjectError('MISSING_PROJECT', '项目入口缺失。');
      const metadata = readHeader(snapshot.projectEntry.text).metadata;
      const groups = Array.isArray(metadata.systems) ? [...metadata.systems] as Record<string, unknown>[] : [];
      for (const group of task.groups) {
        const old = groups.find(item => item.id === group.id), next = { id: group.id, title: group.label, color: group.color, ...(group.parent ? { parent: group.parent } : {}) };
        if (old && (old.title !== next.title || old.color !== next.color || (old.parent ?? '') !== (next.parent ?? ''))) throw new ProjectError('GROUP_CONFLICT', '另一任务已建立同身份但内容不同的分类，请核对。');
        if (!old) groups.push(next);
      }
      changes.push({ path: 'PROJECT.md', baseHash: snapshot.projectEntry.hash, text: setMetadata(snapshot.projectEntry.text, { systems: groups }) });
    }
    return { projectId: task.projectId, requestId: `work-finish-${task.id}-${task.generation}`, baseRevision: task.baseRevision, reason: task.title, actor: 'llm', changes, dependencies: allDependencies };
  }
  async finish(id: string, connectionId: string, input: { taskId: string; generation: number; dependencies?: Record<string, string> }) {
    return this.serial(id, async () => {
      const prepared = await this.service.collaborationExclusive(id, async (root, snapshot) => {
        const store = await this.load(root, id), existing = this.find(store, input.taskId);
        if (existing.status === 'completed' && existing.connectionId === connectionId && existing.generation === input.generation) return { done: this.receipt(existing) };
        const task = this.writable(store, { ...input, connectionId }); this.stable(snapshot);
        const request = task.finishRequest ?? this.buildCommit(snapshot, task, input.dependencies);
        task.finishRequest = request; this.progress(task); await this.save(root, store); return { request };
      });
      if (prepared.done) return prepared.done;
      try {
        await this.service.commit(prepared.request!, { ...input, connectionId });
        return await this.service.collaborationExclusive(id, async root => { const store = await this.load(root, id), task = this.find(store, input.taskId); const committed = (await history(root, id)).find(entry => entry.valid && entry.manifest.requestId === prepared.request!.requestId); task.status = 'completed'; task.revision = committed?.manifest.id ?? null; task.updatedAt = nowText(); delete task.error; await this.save(root, store); this.emit(id, 'work', task.id); return this.receipt(task); });
      } catch (error) {
        await this.service.collaborationExclusive(id, async root => { const store = await this.load(root, id), task = this.find(store, input.taskId); if (task.status === 'completed') return; task.status = 'failed'; task.generation++; task.error = error instanceof Error ? error.message : '保存失败，工作稿已保留。'; task.updatedAt = nowText(); await this.save(root, store); this.emit(id, 'work', task.id); });
        throw error;
      }
    });
  }
  async control(id: string, connectionId: string | undefined, input: { taskId: string; action: string; requestId?: string }) {
    return this.serial(id, async () => {
      if (input.action === 'undo') {
        const task = await this.service.collaborationExclusive(id, async root => this.find(await this.load(root, id), input.taskId));
        if (connectionId) throw new ProjectError('USER_ACTION_REQUIRED', '撤销由用户在工作台执行。');
        if (task.undone) return { taskId: task.id, status: 'undone' };
        if (task.status !== 'completed' || !task.revision) throw new ProjectError('WORK_UNDO_UNAVAILABLE', '此任务没有可以撤销的已保存修改。');
        // 反向计划先持久化；响应丢失时复用同一请求，不重复逆向修改后来保存的内容。
        const plan = task.undoRequest ?? await this.service.prepareUndo(id, task.revision);
        if (!task.undoRequest) await this.service.collaborationExclusive(id, async root => { const store = await this.load(root, id); this.find(store, task.id).undoRequest = plan; await this.save(root, store); });
        const snapshot = plan.changes.length ? await this.service.commit(plan) : await this.service.read(id);
        return this.service.collaborationExclusive(id, async root => { const store = await this.load(root, id), current = this.find(store, task.id); current.undone = true; current.dismissed = true; await this.save(root, store); this.emit(id); return { taskId: task.id, status: 'undone', revision: snapshot.revision }; });
      }
      return this.service.collaborationExclusive(id, async (root, snapshot) => {
        const store = await this.load(root, id), task = this.find(store, input.taskId);
        const operation = input.requestId ? this.operation(task, input.requestId, { ...input, connectionId }) : undefined;
        if (operation?.old) return operation.old.result;
        if (input.action === 'dismiss') {
          if (task.status === 'running') throw new ProjectError('WORK_RUNNING', '请先停止任务。'); task.dismissed = true;
        } else if (input.action === 'cancel') {
          if (task.status === 'completed') throw new ProjectError('WORK_COMPLETED', '任务已完成，请使用撤销本次修改。');
          if (connectionId && task.connectionId !== connectionId) throw new ProjectError('WORK_STALE_OWNER', '不能取消其他连接的任务。');
          if (task.status === 'cancelled') return this.receipt(task);
          task.status = 'cancelled'; task.generation++; task.error = '任务已停止，原稿和工作稿均保留。';
        } else if (input.action === 'resume') {
          if (task.status === 'running' || task.status === 'completed') throw new ProjectError('WORK_NOT_INTERRUPTED', '仅可恢复已停止或失败的任务。');
          const owner = connectionId ?? task.connectionId; this.requireConnection(owner); this.stable(snapshot);
          for (const document of task.documents) {
            if ((snapshot.files?.[document.current.path] ?? null) !== (document.original?.hash ?? null)) throw new ProjectError('WORK_BASE_CONFLICT', '正式文档已变化，保留工作稿，请先比较后另开任务。', { documentId: document.current.id });
            for (const [path, hash] of Object.entries(document.dependencies)) if ((snapshot.files?.[path] ?? null) !== hash) throw new ProjectError('WORK_BASE_CONFLICT', '原稿或伴随文件已变化，请先比较恢复稿。', { path });
            if (store.tasks.some(other => other.id !== task.id && other.status === 'running' && other.documentIds.includes(document.current.id))) throw new ProjectError('DOCUMENT_LOCKED', '另一任务正在编写此文档。');
          }
          task.connectionId = owner; task.instance = this.instance; task.pid = runtimePid; task.generation++; task.status = 'running'; task.dismissed = false; delete task.finishRequest; this.progress(task);
        } else throw new ProjectError('INVALID_REQUEST', '不支持的协作控制操作。');
        task.updatedAt = nowText(); const result = this.receipt(task);
        if (operation) task.operations[input.requestId!] = { hash: operation.hash, result };
        await this.save(root, store); this.emit(id, 'work', task.id); return result;
      });
    });
  }
}
