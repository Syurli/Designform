import { randomUUID, cp, mkdir, readdir, realpath, rm, watch, type FSWatcher, path, defaultTemplateRoot, Buffer, backupStateFile } from './platform.ts';
import { stringify } from 'yaml';
import { parseKnowledge, parseProjectInfo, readHeader, type MarkdownFile } from '../shared/markdown.ts';
import { DOCUMENT_FORMAT, type CommitRequest, type DocumentDraft, type FileChange, type ProjectInfo, type ProjectSnapshot, type WorkspaceItem, type Proposal } from '../shared/model.ts';
import { assertDocumentPath, fingerprint, hashFiles, optionalBytes, ProjectError, readCurrentFiles, removeFile, resolveInside, sha256, writeBytes, withProjectLock } from './files.ts';
import { history, publishRevision, readRevision, rebuildHistoryIndex, recoverPublishedSnapshots, type HistoryEntry } from './history.ts';
import { workspace } from './workspace.ts';
import { collectFiles, prepareImport, readImport } from './exchange.ts';
import { undoText } from '../shared/undo.ts';
import { rewriteLinks, diagnoseLinks } from '../shared/links.ts';
import { answerQuestion, inquiry, section, questionAvailable } from '../shared/inquiry.ts';
import { questionDocument, setMetadata, putRelation, removeRelation } from '../shared/editing.ts';
import { indexSnapshot } from './index-store.ts';
import { companionIdPattern, companionKind, inkCompanionPath, layoutCompanionPath, validateCompanionFile, COMPANION_MAX_BYTES } from '../shared/document-companion.ts';

/** 最近项目是本机配置，不混入任何游戏的公开策划目录。 */
interface Registry { projects: ProjectInfo[]; current: string | null }
/** 提交日志保存修改前与候选内容的位置，崩溃后不凭猜测回写。 */
interface Transaction {
  id: string;
  request: CommitRequest;
  requestHash: string;
  phase: 'prepared' | 'writing' | 'files-written' | 'complete' | 'rolled-back' | 'conflict';
  createdAt: string;
  progress: string[];
  revision?: string;
  /** 包含未修改文件的完整基准，最终核对能发现批次中的额外外部修改。 */
  beforeHashes: Record<string, string>;
}

/** 字节转换只对 Markdown 进行；图片附件保留原始字节参与快照。 */
function markdownFiles(current: Map<string, Buffer>): MarkdownFile[] {
  return [...current].filter(([name]) => name.endsWith('.md')).map(([name, bytes]) => ({ path: name, text: bytes.toString('utf8'), hash: sha256(bytes) }));
}
/** 公开伴随文件仅在快照中单列，不送入知识正文解析。 */
function companionFiles(current: Map<string, Buffer>) {
  return Object.fromEntries([...current].filter(([name]) => companionKind(name)).map(([name, bytes]) => [name, { text: bytes.toString('utf8'), hash: sha256(bytes) }]));
}
/** 对外部编辑的布局和笔画也执行格式校验，避免发布损坏版本。 */
function companionDiagnostics(current: Map<string, Buffer>) {
  const result: ProjectSnapshot['diagnostics'] = [];
  for (const [name, bytes] of current) if (companionKind(name)) try { validateCompanionFile(name, new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { result.push({ path: name, code: 'INVALID_COMPANION', severity: 'error', message: error instanceof Error ? error.message : '伴随文件格式无效。' }); }
  return result;
}
function changedPaths(current: Record<string, string>, previous: Record<string, string> = {}) {
  return [...new Set([...Object.keys(current), ...Object.keys(previous)])].filter(name => name !== 'README.md' && current[name] !== previous[name]).sort();
}
function requestDigest(request: CommitRequest) { return sha256(JSON.stringify(request)); }
/** 二进制编码只用于公开附件，正文一直保持 UTF-8；解码后参与同一提交和恢复机制。 */
function changeBytes(change: FileChange): Buffer | null {
  if (change.text === null) return null;
  if (change.encoding === 'base64') {
    if (!change.path.startsWith('docs/assets/') || !/\.(png|jpe?g|webp|gif|txt|csv|json|pdf)$/i.test(change.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(change.text)) throw new ProjectError('INVALID_ASSET', '附件路径、格式或编码无效。');
    return Buffer.from(change.text, 'base64');
  }
  return Buffer.from(change.text, 'utf8');
}

/**
 * 一个服务协调本机打开的项目。每个项目有独立队列，应用内提交互斥；普通外部编辑仍由哈希检查保护。
 * 公开文件始终是权威源，最近记录只保存入口，绝不通过旧缓存覆盖磁盘。
 */
export class ProjectService {
  readonly home: string;
  readonly templateRoot: string;
  private registry: Registry = { projects: [], current: null };
  private queues = new Map<string, Promise<unknown>>();
  private ready: Promise<void>;
  private watchers = new Map<string, FSWatcher>();
  private observations = new Map<string, { fingerprint: string; since: number }>();
  private touched = new Map<string, number>();
  private backingUp = new Set<string>();
  private verifiedHistory = new Map<string, { entries: HistoryEntry[]; at: number }>();

  constructor(home: string, templateRoot = defaultTemplateRoot) {
    this.home = path.resolve(home); this.templateRoot = templateRoot;
    this.ready = this.initialize();
  }

  /** 初次只建立项目中心，不在启动时扫描用户其他游戏目录。 */
  private async initialize() {
    await mkdir(this.home, { recursive: true });
    const saved = await optionalBytes(this.home, 'library.json');
    if (saved) {
      try {
        const value = JSON.parse(saved.toString('utf8')) as Registry;
        if (!Array.isArray(value.projects)) throw new Error('最近项目记录格式错误。');
        this.registry = value;
      } catch { throw new ProjectError('REGISTRY_DAMAGED', '最近项目记录无法读取，已保留原文件；可从项目目录恢复入口。'); }
    }
  }

  /** 同项目排队，不因一个失败提交阻断后续恢复；其他项目互不阻塞。 */
  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => { const project = this.registry.projects.find(project => project.id === key); return project ? withProjectLock(project.path, action) : action(); });
    this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }

  private project(id: string) {
    const project = this.registry.projects.find(project => project.id === id);
    if (!project) throw new ProjectError('PROJECT_NOT_OPEN', '项目尚未打开或身份不匹配。');
    return project;
  }
  private async saveRegistry() { await writeBytes(this.home, 'library.json', JSON.stringify(this.registry, null, 2)); }
  /** 监听只标记变化；哈希扫描仍负责判断真正内容，平台不支持时继续使用补扫。 */
  private observe(project: ProjectInfo) {
    if (this.watchers.has(project.id)) return;
    try {
      const watcher = watch(project.path, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '').replaceAll('\\', '/');
        if (name === 'PROJECT.md' || name.startsWith('docs/')) this.touched.set(project.id, Date.now());
        if (name === 'versions' || name.startsWith('versions/')) this.verifiedHistory.delete(project.id);
      });
      watcher.on('error', () => { watcher.close(); this.watchers.delete(project.id); this.verifiedHistory.delete(project.id); });
      this.watchers.set(project.id, watcher);
    } catch { /* 部分文件系统不支持监听，定期扫描和窗口焦点刷新仍然有效。 */ }
  }
  close() { this.watchers.forEach(watcher => watcher.close()); this.watchers.clear(); }
  private libraryView() { return { ...this.registry, projects: [...this.registry.projects], defaultDirectory: this.home }; }

  /** 项目库身份以各项目当前 PROJECT.md 为准；失联或损坏项目保留最近登记，供用户重新定位。 */
  async list() {
    await this.ready;
    return this.exclusive('library', async () => {
      const refreshed = await Promise.all(this.registry.projects.map(async project => {
        try {
          const bytes = await optionalBytes(project.path, 'PROJECT.md');
          if (!bytes) return project;
          const actual = parseProjectInfo({ path: 'PROJECT.md', text: bytes.toString('utf8'), hash: sha256(bytes) }, project.path);
          // 磁盘 ID 被改动时仍保留原登记，不悄悄把另一项目塞进当前历史身份。
          return actual.id === project.id ? actual : project;
        } catch { return project; }
      }));
      if (JSON.stringify(refreshed) !== JSON.stringify(this.registry.projects)) {
        this.registry.projects = refreshed;
        await this.saveRegistry();
      }
      return this.libraryView();
    });
  }

  /** 只打开用户明确传入且有公开项目入口的目录，检查重复身份避免两个副本串写。 */
  async open(directory: string): Promise<ProjectInfo> {
    await this.ready;
    return this.exclusive('library', async () => {
      const canonical = await realpath(directory);
      const bytes = await optionalBytes(canonical, 'PROJECT.md');
      if (!bytes) throw new ProjectError('MISSING_PROJECT', '该目录没有 PROJECT.md；普通 GDD / DD 请使用导入流程。');
      const project = parseProjectInfo({ path: 'PROJECT.md', text: bytes.toString('utf8'), hash: sha256(bytes) }, canonical);
      const packageBytes = await optionalBytes(canonical, 'PACKAGE.json');
      if (packageBytes) {
        const manifest = JSON.parse(packageBytes.toString('utf8')) as { state: string; projectId: string; files: Record<string, string> };
        if (manifest.state !== 'complete' || manifest.projectId !== project.id || !manifest.files) throw new ProjectError('PACKAGE_DAMAGED', '项目包尚未完成或身份不正确。');
        // 包的首次打开校验结束后留下导入凭据；后续正常编辑不能被原包哈希误判成损坏。
        if (!(await optionalBytes(canonical, '.cewen/package-opened.json'))) {
          for (const [name, hash] of Object.entries(manifest.files)) { const content = await optionalBytes(canonical, name); if (!content || sha256(content) !== hash) throw new ProjectError('PACKAGE_DAMAGED', `项目包文件校验失败：${name}`); }
          const work = await optionalBytes(canonical, '.cewen/workspace-export.json');
          if (work) {
            const saved = JSON.parse(work.toString('utf8')) as { items: WorkspaceItem[] }; let restored = await workspace(canonical);
            const remaining = saved.items.filter(item => !restored.items.some(existing => existing.id === item.id));
            while (remaining.length) { const index = remaining.findIndex(item => !item.parent || restored.items.some(parent => parent.id === item.parent)); if (index < 0) throw new ProjectError('PACKAGE_WORKSPACE_INVALID', '备份分组归属缺失或成环，原包保留。'); const [item] = remaining.splice(index,1); restored = await workspace(canonical, { baseRevision: restored.revision, item }); }
          }
          await writeBytes(canonical, '.cewen/package-opened.json', JSON.stringify({ openedAt: new Date().toISOString(), manifestHash: sha256(packageBytes) }));
        }
      }
      const duplicate = this.registry.projects.find(entry => entry.id === project.id && entry.path.toLowerCase() !== canonical.toLowerCase());
      if (duplicate) throw new ProjectError('DUPLICATE_PROJECT', '同一项目身份已经从另一目录打开，请恢复原入口或复制为新项目。', { existingPath: duplicate.path });
      this.registry.projects = [project, ...this.registry.projects.filter(entry => entry.id !== project.id)];
      this.registry.current = project.id;
      await this.saveRegistry();
      return project;
    });
  }

  /** 新建始终使用空目标目录；模板只复制虚构材料，绝不以真实资料作为默认。 */
  async create(name: string, kind: 'blank' | 'basic' | 'example', parent = this.home, setup?: { brief?: string; categories?: import('../shared/model.ts').KnowledgeGroup[] }): Promise<ProjectSnapshot> {
    await this.ready;
    name = name.trim();
    if (!name || name.length > 100) throw new ProjectError('INVALID_NAME', '请输入 1～100 个字符的项目名称。');
    if (setup && (typeof setup !== 'object' || (setup.brief !== undefined && (typeof setup.brief !== 'string' || setup.brief.length > 20000)) || (setup.categories !== undefined && (!Array.isArray(setup.categories) || setup.categories.length > 60 || setup.categories.some(group => !group || !/^[A-Za-z0-9_-]{1,120}$/.test(group.id) || typeof group.label !== 'string' || !group.label.trim() || !/^#[0-9a-f]{6}$/i.test(group.color)))))) throw new ProjectError('INVALID_SETUP','创作起点或分类内容无效，请保留草稿后重新选择。');
    const id = `project-${randomUUID()}`;
    const folderName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 65) || '新项目';
    const directory = path.join(path.resolve(parent), `${folderName}-${id.slice(-8)}`);
    await mkdir(directory, { recursive: false });
    if (kind === 'example') {
      // 根目录已经由本次新建独占，逐项复制避免 cp 把该空目录视为覆盖目标。
      for (const entry of await readdir(this.templateRoot)) await cp(path.join(this.templateRoot, entry), path.join(directory, entry), { recursive: true, force: false, errorOnExist: true });
    }
    const guide = await optionalBytes(this.templateRoot, 'docs/README.md');
    if (guide) await writeBytes(directory, 'docs/README.md', kind==='example'?guide:'# 策划文档\n\n总纲位于 gdd，专项设计位于 dd，待讨论问题位于 questions，图片位于 assets。\n\n正文优先满足阅读；在自然文句中链接相关设计。保留文档身份，不将未决定的建议写成正式规则。设计分类在项目入口登记，个人草稿与视图不进入正文。\n');
    await writeBytes(directory, 'PROJECT.md', `---\n${stringify({ id, name, format: DOCUMENT_FORMAT, description: kind === 'example' ? '完全虚构的教学示例，可放心修改和复制。' : '', example: kind === 'example', ...(kind !== 'example' ? { minimumAppVersion: '0.4.0', systems: (setup?.categories ?? []).map(group => ({ id: group.id, title: group.label, color: group.color })) } : {}) })}---\n\n# ${name.replace(/[\r\n]+/g, ' ')}\n\n当前策划保存在 docs，历史版本保存在 versions。\n${setup?.brief?.trim() ? `\n## 创作起点（待细化）\n\n${setup.brief.trim()}\n` : ''}`);
    if (kind === 'basic') await writeBytes(directory, 'docs/gdd/GDD.md', `---\nid: gdd-${randomUUID()}\ntype: gdd\nstatus: draft\n---\n\n# ${name} · 游戏总纲\n\n## 目标体验\n\n## 核心循环\n\n## 首版范围\n\n## 尚未决定\n`);
    const project = await this.open(directory);
    return this.read(project.id);
  }

  /** 读取时主动扫描磁盘并记录实际观察到的有效外部变更。 */
  async read(id: string, recordExternal = true, verifyHistory = false): Promise<ProjectSnapshot> {
    await this.ready;
    if (verifyHistory) this.verifiedHistory.delete(id);
    const snapshot = await this.exclusive(id, () => this.load(this.project(id), recordExternal));
    if (!snapshot.recoveryRequired && !snapshot.diagnostics.some(issue => issue.severity === 'error' || ['FILES_CHANGING','EXTERNAL_BATCH_OPEN'].includes(issue.code))) void this.automaticBackup(id).catch(() => {});
    return snapshot;
  }

  private async pending(root: string): Promise<Transaction[]> {
    const directory = await resolveInside(root, '.cewen/transactions');
    await mkdir(directory, { recursive: true });
    const result: Transaction[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9-]+$/i.test(entry.name)) continue;
      const raw = await optionalBytes(root, `.cewen/transactions/${entry.name}/transaction.json`);
      if (!raw) continue;
      let transaction: Transaction;
      try { transaction = JSON.parse(raw.toString('utf8')); }
      catch { throw new ProjectError('TRANSACTION_DAMAGED', '恢复日志损坏，已停止写入并保留原始文件。'); }
      if (transaction.id !== entry.name || transaction.request?.projectId !== this.registry.projects.find(project => project.path === root)?.id || transaction.requestHash !== requestDigest(transaction.request) || !Array.isArray(transaction.request.changes) || !['prepared','writing','files-written','complete','rolled-back','conflict'].includes(transaction.phase)) throw new ProjectError('TRANSACTION_DAMAGED', '恢复日志身份或内容校验失败，未执行回写。');
      for (const change of transaction.request.changes) { if (change.encoding === 'base64' && change.path.startsWith('docs/assets/')) await resolveInside(root, change.path); else assertDocumentPath(change.path); }
      if (transaction.phase !== 'complete' && transaction.phase !== 'rolled-back') result.push(transaction);
    }
    return result;
  }

  /** 读模型可用不等于项目完全有效；诊断与落后状态必须同步提供给界面。 */
  private async load(project: ProjectInfo, recordExternal: boolean): Promise<ProjectSnapshot> {
    this.observe(project);
    await recoverPublishedSnapshots(project.path);
    const current = await readCurrentFiles(project.path), files = markdownFiles(current);
    const actual = parseProjectInfo(files.find(file => file.path === 'PROJECT.md')!, project.path);
    if (actual.id !== project.id) throw new ProjectError('PROJECT_ID_CHANGED', '磁盘项目 ID 已变化，请核对身份后重新打开，未继续写入。');
    const knowledge = parseKnowledge(files), hashes = hashFiles(current), currentFingerprint = fingerprint(hashes);
    knowledge.diagnostics.push(...companionDiagnostics(current));
    knowledge.diagnostics.push(...diagnoseLinks(new Map([...current].map(([name,bytes]) => [name, name.endsWith('.md') ? bytes.toString('utf8') : null]))));
    const cached = this.verifiedHistory.get(project.id);
    const versions = cached && this.watchers.has(project.id) && Date.now() - cached.at < 60000 ? cached.entries : await history(project.path, project.id), pending = await this.pending(project.path);
    if (versions !== cached?.entries) this.verifiedHistory.set(project.id, { entries: versions, at: Date.now() });
    const invalid = versions.filter(entry => !entry.valid);
    let head = versions.filter(entry => entry.valid).at(-1)?.manifest;
    if (invalid.length) knowledge.diagnostics.push(...invalid.map(entry => ({ path: `versions/${entry.manifest.label}`, code: 'HISTORY_DAMAGED', severity: 'error' as const, message: entry.problem! })));
    const externalBatch = await optionalBytes(project.path, '.cewen/external-batch.json');
    if (externalBatch) knowledge.diagnostics.push({ path: 'docs/', code: 'EXTERNAL_BATCH_OPEN', severity: 'warning', message: '外部编辑批次尚未结束；当前稿可读，暂不自动发布中间版本。' });
    const hasErrors = knowledge.diagnostics.some(issue => issue.severity === 'error');
    if (recordExternal && !externalBatch && !pending.length && !hasErrors && head?.fingerprint !== currentFingerprint) {
      const observed = this.observations.get(project.id);
      if (observed?.fingerprint !== currentFingerprint) this.observations.set(project.id, { fingerprint: currentFingerprint, since: Date.now() });
      const stable = !head || (observed?.fingerprint === currentFingerprint && Date.now() - Math.max(observed.since, this.touched.get(project.id) ?? 0) >= 1000);
      // 跨两次观察的稳定窗口再加最终哈希核对，不把瞬时的半个批次当成正式版本。
      const check = await readCurrentFiles(project.path);
      if (stable && fingerprint(hashFiles(check)) === currentFingerprint) { head = await publishRevision(project.path, project.id, current, { actor: head ? 'external' : 'user', reason: head ? '同步外部文档修改' : '建立项目初始版本', requestId: `observed-${randomUUID()}` }, currentFingerprint, changedPaths(hashes, head?.files)); this.verifiedHistory.delete(project.id); }
      else knowledge.diagnostics.push({ path: 'docs/', code: 'FILES_CHANGING', severity: 'warning', message: '文件仍在变化，稍后重新扫描；本次未发布版本。' });
    }
    const snapshot: ProjectSnapshot = { project: actual, ...knowledge, companions: companionFiles(current), fingerprint: currentFingerprint, revision: head?.id ?? null, revisionLabel: head?.label, files: hashes, recoveryRequired: pending.length > 0 || invalid.length > 0 };
    // 索引失败不遮蔽磁盘稿，保留诊断并允许用户继续读取公开文件。
    try { await indexSnapshot(project.path, snapshot); } catch (error) { snapshot.diagnostics.push({ path: '.cewen/index.sqlite', code: 'INDEX_UNAVAILABLE', severity: 'warning', message: `索引暂不可用：${error instanceof Error ? error.message : String(error)}` }); }
    return snapshot;
  }

  async versions(id: string): Promise<HistoryEntry[]> { await this.ready; const project = this.project(id); return this.exclusive(id, () => history(project.path, id)); }

  /** 外部编辑完成后显式封版；软件关闭期间的每轮修改也可用此入口留下快照。 */
  async checkpoint(id: string, reason: string, requestId: string) {
    await this.ready;
    return this.exclusive(id, async () => {
      const project = this.project(id), snapshot = await this.load(project, false), versions = await history(project.path, id);
      if (snapshot.recoveryRequired || snapshot.diagnostics.some(issue => issue.severity === 'error')) throw new ProjectError('CHECKPOINT_NOT_READY', '当前文档有错误或未完成写入，无法封版。');
      if (!reason.trim() || !requestId.trim()) throw new ProjectError('INVALID_REQUEST', '封版需要本轮说明和请求 ID。');
      const head = versions.at(-1)?.manifest;
      const previousRequest = versions.find(entry => entry.valid && entry.manifest.requestId === requestId)?.manifest;
      if (previousRequest) {
        if (previousRequest.fingerprint !== snapshot.fingerprint || previousRequest.reason !== reason) throw new ProjectError('IDEMPOTENCY_MISMATCH', '这个封版请求已经用于其他内容，请使用新的请求 ID。');
        return snapshot;
      }
      if (head?.fingerprint === snapshot.fingerprint) return snapshot;
      const files = await readCurrentFiles(project.path);
      if (fingerprint(hashFiles(files)) !== snapshot.fingerprint) throw new ProjectError('FILES_CHANGING', '文件仍在变化，尚未完成封版。');
      await publishRevision(project.path, id, files, { reason, requestId, actor: 'external' }, sha256(JSON.stringify({ reason, requestId, fingerprint: snapshot.fingerprint })), changedPaths(hashFiles(files), head?.files));
      this.verifiedHistory.delete(id);
      return this.load(project, false);
    });
  }

  /** 历史视图完全从快照解析，不向当前文档借正文或附件。 */
  async revision(id: string, revision: string): Promise<ProjectSnapshot> {
    await this.ready;
    return this.exclusive(id, async () => {
      const project = this.project(id), saved = await readRevision(project.path, id, revision), files = markdownFiles(saved.files);
      const actual = parseProjectInfo(files.find(file => file.path === 'PROJECT.md')!, project.path);
      return { project: actual, ...parseKnowledge(files), companions: companionFiles(saved.files), fingerprint: saved.manifest.fingerprint, files: hashFiles(saved.files), revision: saved.manifest.id, revisionLabel: saved.manifest.label, historical: true, recoveryRequired: false };
    });
  }

  /** 恢复先生成可审核的多文件计划；实际提交仍核对所有当前文件哈希。 */
  async prepareRestore(id: string, revision: string): Promise<CommitRequest> {
    await this.ready;
    return this.exclusive(id, async () => {
      const project = this.project(id), snapshot = await this.load(project, true), current = await readCurrentFiles(project.path), saved = await readRevision(project.path, id, revision);
      const changes: FileChange[] = [];
      for (const name of new Set([...current.keys(), ...saved.files.keys()])) {
        const old = current.get(name), next = saved.files.get(name);
        if (old && next && sha256(old) === sha256(next)) continue;
        const binary = !name.endsWith('.md') && !companionKind(name);
        changes.push({ path: name, baseHash: old ? sha256(old) : null, text: next ? next.toString(binary ? 'base64' : 'utf8') : null, ...(binary ? { encoding: 'base64' as const } : {}) });
      }
      return { projectId: id, requestId: randomUUID(), baseRevision: snapshot.revision, reason: `恢复 ${saved.manifest.label}`, actor: 'restore', changes, dependencies: hashFiles(current), restoredFrom: saved.manifest.id };
    });
  }

  /** 多文件外部编辑显式包围一轮，避免静默观察到中途的合法半成品。 */
  async beginExternalBatch(id: string, requestId: string) {
    const snapshot = await this.read(id);
    return this.exclusive(id, async () => {
      const root = this.project(id).path, saved = await optionalBytes(root, '.cewen/external-batch.json');
      if (saved) { const record = JSON.parse(saved.toString('utf8')); if (record.requestId === requestId) return record; throw new ProjectError('EXTERNAL_BATCH_OPEN', '已有外部批次，请先结束该轮。'); }
      if (snapshot.recoveryRequired) throw new ProjectError('RECOVERY_REQUIRED', '请先处理未完成提交。');
      const record = { id: randomUUID(), requestId, revision: snapshot.revision, fingerprint: snapshot.fingerprint, startedAt: new Date().toISOString() };
      await writeBytes(root, '.cewen/external-batch.json', JSON.stringify(record, null, 2)); return record;
    });
  }
  async endExternalBatch(id: string, batch: string, reason: string) {
    await this.ready;
    const root = this.project(id).path, receipt = `.cewen/requests/external-${sha256(batch)}.json`;
    // 完成回执先于移除批次标记落盘，响应丢失后的重试不会开启或结束另一轮。
    return this.exclusive(id, async () => {
      const bytes = await optionalBytes(root, receipt);
      const marker = await optionalBytes(root, '.cewen/external-batch.json');
      if (bytes) {
        const record = JSON.parse(bytes.toString('utf8'));
        if (record.batch !== batch || record.reason !== reason) throw new ProjectError('IDEMPOTENCY_MISMATCH', '此批次已使用其他说明结束，请保留原请求后重试。');
        if (marker && JSON.parse(marker.toString('utf8')).id === batch) await removeFile(root, '.cewen/external-batch.json');
        return this.load(this.project(id), false);
      }
      if (!marker || JSON.parse(marker.toString('utf8')).id !== batch) throw new ProjectError('INVALID_BATCH', '外部批次不存在或身份不匹配。');
      if (!reason.trim()) throw new ProjectError('INVALID_REQUEST', '结束批次需要本轮说明。');
      const snapshot = await this.load(this.project(id), false);
      if (snapshot.recoveryRequired || snapshot.diagnostics.some(issue => issue.severity === 'error')) throw new ProjectError('CHECKPOINT_NOT_READY', '当前文档有错误或未完成写入，无法封版。');
      const versions = await history(root, id), head = versions.at(-1)?.manifest, files = await readCurrentFiles(root);
      if (fingerprint(hashFiles(files)) !== snapshot.fingerprint) throw new ProjectError('FILES_CHANGING', '文件仍在变化，请写完本轮文件后重试。');
      // 以本次一致读取作为边界；之后发生的外部保存属于下一轮观察，不回写旧内容。
      const revision = head?.fingerprint === snapshot.fingerprint ? head : await publishRevision(root, id, files, { actor: 'external', reason, requestId: `external-batch-${batch}` }, sha256(JSON.stringify({ batch, reason, fingerprint: snapshot.fingerprint })), changedPaths(hashFiles(files), head?.files));
      this.verifiedHistory.delete(id);
      await writeBytes(root, receipt, JSON.stringify({ batch, reason, revision: revision.id, completedAt: new Date().toISOString() }, null, 2));
      await removeFile(root, '.cewen/external-batch.json');
      return this.load(this.project(id), false);
    });
  }

  async reverseRelation(id: string, relationId: string) {
    const snapshot = await this.read(id), edge = snapshot.edges.find(edge => edge.id === relationId && edge.type !== 'contains');
    if (!edge || edge.id.startsWith('reference:')) throw new ProjectError('INVALID_RELATION', '只允许反转显式语义关系；正文引用请修改原文链接。');
    const source = snapshot.nodes.find(node => node.id === edge.source)!, target = snapshot.nodes.find(node => node.id === edge.target)!;
    if (target.kind === 'system') throw new ProjectError('INVALID_RELATION', '请将来源选为实际文档或规则条目。');
    const documents = new Map(snapshot.documents.map(doc => [doc.path, doc]));
    const texts = new Map([[source.documentPath, removeRelation(documents.get(source.documentPath)!.text, edge.id)]]);
    texts.set(target.documentPath, putRelation(texts.get(target.documentPath) ?? documents.get(target.documentPath)!.text, target.anchor, { id: edge.id, type: ({ depends: '依赖', constrains: '约束', relates: '关联', references: '引用', replaces: '替代', contains: '包含' })[edge.type], target: source.id, note: edge.note }));
    return this.commit({ projectId: id, requestId: randomUUID(), baseRevision: snapshot.revision, reason: `反转关系：${source.title} / ${target.title}`, actor: 'user', changes: [...texts].map(([path,text]) => ({ path, text, baseHash: documents.get(path)!.hash })) });
  }
  async archiveDocuments(id: string, documentIds: string[], archived: boolean) {
    const snapshot = await this.read(id), documents = snapshot.documents.filter(doc => documentIds.includes(doc.id) && doc.type !== 'guide');
    if (!documents.length || documents.length !== new Set(documentIds).size) throw new ProjectError('INVALID_SELECTION', '请选择实际设计文档。');
    return this.commit({ projectId: id, requestId: randomUUID(), baseRevision: snapshot.revision, reason: `${archived ? '归档' : '恢复'} ${documents.length} 份文档`, actor: 'user', changes: documents.map(doc => ({ path: doc.path, baseHash: doc.hash, text: setMetadata(doc.text, { status: archived ? 'archived' : 'draft' }) })) });
  }

  /** 撤销旧批次使用反向差异；后续改答和其他文档不能被整版替换误删。 */
  async prepareUndo(id: string, revision: string): Promise<CommitRequest> {
    const current = await this.read(id), root = this.project(id).path;
    return this.exclusive(id, async () => {
      const saved = await readRevision(root, id, revision);
      if (!saved.manifest.parent) throw new ProjectError('INITIAL_REVISION', '初始版本不能作为整批撤销目标。');
      const parent = await readRevision(root, id, saved.manifest.parent), files = await readCurrentFiles(root), changes: FileChange[] = [];
      for (const name of saved.manifest.changedPaths) {
        const before = parent.files.get(name), after = saved.files.get(name), now = files.get(name);
        if ((!before && !after) || (before && after && sha256(before) === sha256(after))) continue;
        let next = before;
        if ((now ? sha256(now) : null) !== (after ? sha256(after) : null)) {
          if (!before || !after || !now || !name.endsWith('.md')) throw new ProjectError('UNDO_CONFLICT', `后续已修改 ${name}，不能直接撤销旧批次。`);
          try { next = Buffer.from(undoText(before.toString('utf8'), after.toString('utf8'), now.toString('utf8'))); }
          catch (error) { throw new ProjectError('UNDO_CONFLICT', `${name}：${(error as Error).message}`); }
        }
        const binary = !name.endsWith('.md') && !companionKind(name);
        changes.push({ path: name, baseHash: now ? sha256(now) : null, text: next?.toString(binary ? 'base64' : 'utf8') ?? null, ...(binary ? { encoding: 'base64' as const } : {}) });
      }
      return { projectId: id, requestId: randomUUID(), baseRevision: current.revision, reason: `撤销批次 ${saved.manifest.label}（保留后续无关修改）`, actor: 'restore', changes, dependencies: hashFiles(files), restoredFrom: saved.manifest.id };
    });
  }

  /** 移动文档一次提交旧路径、新路径及受影响相对链接，身份不随文件名改变。 */
  async moveDocument(id: string, documentId: string, destination: string) {
    assertDocumentPath(destination);
    const snapshot = await this.read(id), document = snapshot.documents.find(doc => doc.id === documentId);
    if (!document || document.type === 'guide' || destination === 'PROJECT.md') throw new ProjectError('INVALID_DOCUMENT', '请选择 GDD、DD 或问题文档。');
    if (destination === document.path) return snapshot;
    if (Object.keys(snapshot.files ?? {}).some(name => name.toLowerCase() === destination.toLowerCase())) throw new ProjectError('PATH_EXISTS', '目标路径已存在，请另选文件名。');
    const mapping = new Map(Object.keys(snapshot.files ?? {}).map(name => [name, name])); mapping.set(document.path, destination);
    const changes: FileChange[] = [{ path: document.path, baseHash: document.hash, text: null }];
    for (const doc of snapshot.documents) {
      const nextPath = doc.id === documentId ? destination : doc.path, text = rewriteLinks(doc.text, doc.path, nextPath, mapping);
      if (nextPath !== doc.path || text !== doc.text) changes.push({ path: nextPath, baseHash: nextPath !== doc.path ? null : doc.hash, text });
    }
    return this.commit({ projectId: id, requestId: randomUUID(), baseRevision: snapshot.revision, reason: `移动文档：${document.title}`, actor: 'user', changes });
  }

  /** 基线为公开追加事件，同名和取消都不改写既有快照。 */
  async baselines(id: string) {
    await this.ready;
    const bytes = await optionalBytes(this.project(id).path, 'versions/BASELINES.md'), records = new Map<string, { id: string; name: string; revision: string; canceled: boolean }>();
    for (const line of (bytes?.toString('utf8') ?? '').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      if (cells.length >= 7 && cells[1].startsWith('baseline-')) records.set(cells[1], { id: cells[1], name: cells[2], revision: cells[3], canceled: cells[4] === '取消' });
    }
    return [...records.values()];
  }
  async baseline(id: string, revision: string, name: string, baselineId?: string, action = '新增') {
    await this.ready;
    return this.exclusive(id, async () => {
      const root = this.project(id).path, saved = await readRevision(root, id, revision);
      if (!name.trim() || name.length > 100 || !['新增','改名','取消'].includes(action)) throw new ProjectError('INVALID_NAME', '请输入有效基线名称和操作。');
      const previous = baselineId ? (await this.baselines(id)).find(item => item.id === baselineId) : undefined;
      if (action !== '新增' && (!previous || previous.revision !== saved.manifest.id)) throw new ProjectError('MISSING_BASELINE', '找不到对应基线。');
      const before = await optionalBytes(root, 'versions/BASELINES.md'), clean = name.trim().replace(/[\r\n|]/g, ' ');
      await writeBytes(root, 'versions/BASELINES.md', `${before?.toString('utf8') ?? '# 命名基线\n\n| 基线 ID | 名称 | 修订 ID | 操作 | 时间 |\n|---|---|---|---|---|\n'}| ${previous?.id ?? `baseline-${randomUUID()}`} | ${clean} | ${saved.manifest.id} | ${action} | ${new Date().toISOString()} |\n`);
      return this.baselines(id);
    });
  }

  /** 阅读位置与布局是可丢弃的编辑器视图，不产生策划修订。 */
  async readingView(id: string, value?: unknown) {
    await this.ready; return this.exclusive(id, async () => {
      const root = this.project(id).path;
      if (value !== undefined) { const text = JSON.stringify(value); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ProjectError('VIEW_TOO_LARGE', '阅读视图超过本地保存范围。'); await writeBytes(root, '.cewen/views/reading.json', text); return { saved: true }; }
      const saved = await optionalBytes(root, '.cewen/views/reading.json'); return saved ? JSON.parse(saved.toString('utf8')) : null;
    });
  }

  async work(id: string, update?: { baseRevision: number; item?: WorkspaceItem; remove?: string }) { await this.ready; return this.exclusive(id, () => workspace(this.project(id).path, update)); }

  /** 预检不会修改当前文档，模型与界面获得完全相同的候选批次。 */
  async importPlan(id: string, directory: string) { await this.ready; return this.exclusive(id, async () => { const project = this.project(id); return prepareImport(await this.load(project, true), project.path, directory); }); }
  /** 文本粘贴在用户工作目录形成独立暂存来源，仍经过同样的映射与差异审核。 */
  async pasteImport(id: string, text: string, kind: string) {
    if (!text.trim() || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new ProjectError('INVALID_IMPORT', '粘贴内容需为 4 MB 以内文本。');
    const relative = `import-inbox/${randomUUID()}`;
    await writeBytes(this.home, `${relative}/${kind === 'json' ? 'cewen-import.json' : '粘贴文档.md'}`, text);
    return this.importPlan(id, await resolveInside(this.home, relative));
  }

  /** 审核修改只作用于暂存候选，保留来源原文；重新预检后才能确认应用。 */
  async reviewImport(id: string, batch: string, selected: string[], edits: Record<string, string>) {
    await this.ready; const root = this.project(id).path, plan = await readImport(root, batch), snapshot = await this.read(id);
    const changes = plan.request.changes.filter(change => change.encoding || selected.includes(change.path)).map(change => ({ ...change, text: edits[change.path] ?? change.text }));
    const candidates = new Map(snapshot.documents.map(doc => [doc.path, { path: doc.path, text: doc.text, hash: doc.hash }]));
    for (const change of changes) if (!change.encoding && change.text !== null) candidates.set(change.path, { path: change.path, text: change.text, hash: sha256(change.text) });
    const next = { ...plan, id: randomUUID(), request: { ...plan.request, requestId: `import-${randomUUID()}`, changes }, diagnostics: parseKnowledge([...candidates.values()]).diagnostics };
    await writeBytes(root, `.cewen/imports/${next.id}/plan.json`, JSON.stringify(next, null, 2)); return next;
  }

  async applyImport(id: string, batch: string) {
    await this.ready; const plan = await readImport(this.project(id).path, batch);
    if (plan.request.projectId !== id) throw new ProjectError('WRONG_PROJECT', '导入计划不属于此项目。');
    return plan.request.changes.length ? this.commit(plan.request) : this.read(id);
  }

  /** 交换包内容可预览且有明确上限；默认只读取公开文档，不附带私人工作记录。 */
  async context(id: string, documentIds: string[] = [], scope: { nodeIds?: string[]; collectionIds?: string[]; annotationIds?: string[] } = {}) {
    const snapshot = await this.read(id);
    const work = await this.work(id), nodeIdsInput = [...(scope.nodeIds ?? [])];
    for (const collectionId of scope.collectionIds ?? []) { const item = work.items.find(item => item.id === collectionId && item.kind === 'collection'); if (!item) throw new ProjectError('MISSING_COLLECTION', '所选工作分组不存在。'); nodeIdsInput.push(...item.targets); }
    documentIds = [...new Set([...documentIds, ...nodeIdsInput.map(nodeId => { const node = snapshot.nodes.find(node => node.id === nodeId); if (!node) throw new ProjectError('MISSING_NODE', '所选条目已移除。'); return node.documentId; })])];
    const annotations = (scope.annotationIds ?? []).map(annotationId => { const item = work.items.find(item => item.id === annotationId && item.kind === 'annotation' && item.scope === 'project'); if (!item) throw new ProjectError('PRIVATE_SCOPE', '只可显式选择项目批注；个人笔记请先由用户发布。'); return { id: item.id, title: item.title, text: item.text, excerpt: item.excerpt, targets: item.targets }; });
    const selected = documentIds.length ? snapshot.documents.filter(document => documentIds.includes(document.id)) : snapshot.documents;
    if (documentIds.some(id => !selected.some(document => document.id === id))) throw new ProjectError('MISSING_DOCUMENT', '上下文选择含有不存在的文档。');
    const ids = new Set(selected.map(document => document.id)), nodes = snapshot.nodes.filter(node => ids.has(node.documentId));
    const nodeIds = new Set(nodes.map(node => node.id));
    const companions: NonNullable<ProjectSnapshot['companions']> = {};
    const annotationDocuments: { documentId: string; path: string; text: string; hash: string }[] = [];
    for (const document of selected) {
      if (!companionIdPattern.test(document.id)) continue;
      for (const path of [layoutCompanionPath(document.id), inkCompanionPath(document.id)]) {
        const file = snapshot.companions?.[path]; if (file) companions[path] = file;
      }
      const path = `docs/annotations/${document.id}.md`, hash = snapshot.files?.[path];
      if (hash) {
        const bytes = await optionalBytes(this.project(id).path, path);
        if (!bytes || sha256(bytes) !== hash) throw new ProjectError('FILES_CHANGING', '公开注释在整理上下文期间发生变化，请重新读取。', { path });
        annotationDocuments.push({ documentId: document.id, path, text: bytes.toString('utf8'), hash });
      }
    }
    const content = { format: DOCUMENT_FORMAT, project: { id: snapshot.project.id, name: snapshot.project.name, categories: snapshot.groups, entry: snapshot.projectEntry?.text }, revision: snapshot.revision, revisionLabel: snapshot.revisionLabel, documents: selected.map(({ id, path, text, hash }) => ({ id, path, text, hash })), relations: snapshot.edges.filter(edge => nodeIds.has(edge.source) || nodeIds.has(edge.target)), companions, annotationDocuments, annotations, instructions: '只修改指定当前文档，保留 ID 和用户原话；布局与笔画是所选文档的伴随文件，不是正文。未决问题不是已决定规则。提交候选提案并由用户采纳。每轮正式修改形成版本。' };
    if (Buffer.byteLength(JSON.stringify(content)) > 4 * 1024 * 1024) throw new ProjectError('CONTEXT_TOO_LARGE', '上下文超过 4 MB，请选择较少的 DD；未静默截断。');
    return content;
  }

  /** 先固定命令与候选，再执行提交；网络重试不重新生成时间或回答身份。 */
  private async operation(id: string, input: { requestId: string }, build: () => Promise<CommitRequest> | CommitRequest) {
    if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 180) throw new ProjectError('INVALID_REQUEST', '需要有效请求 ID。');
    return this.exclusive(id, async () => {
      const root = this.project(id).path, name = `.cewen/requests/${sha256(input.requestId)}.json`, digest = sha256(JSON.stringify(input));
      const saved = await optionalBytes(root, name);
      if (saved) { const record = JSON.parse(saved.toString('utf8')); if (record.digest !== digest) throw new ProjectError('IDEMPOTENCY_MISMATCH', '此请求 ID 已用于不同内容。'); return record.request as CommitRequest; }
      const request = await build(); await writeBytes(root, name, JSON.stringify({ digest, request }, null, 2)); return request;
    });
  }

  /** 发布问询可以由模型完成；推荐选项不会自动变成用户答案。 */
  async publishQuestions(id: string, input: { requestId: string; round: string; questions: { id: string; title: string; background: string; options: string[]; targets: string[]; mode?: 'single' | 'multiple'; follows?: string; condition?: string; when?: { questionId: string; option?: string } }[] }) {
    const snapshot = await this.read(id);
    const request = await this.operation(id, input, () => {
    if (!input.requestId || typeof input.round !== 'string' || !input.round.trim() || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 30) throw new ProjectError('INVALID_QUESTIONS', '一轮问询需要 1～30 个有稳定 ID 的问题。');
    const changes: FileChange[] = input.questions.map(question => {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(question.id) || !question.title?.trim() || typeof question.background !== 'string' || !Array.isArray(question.options) || question.options.length > 26 || question.options.some(option => typeof option !== 'string') || !Array.isArray(question.targets) || question.targets.some(target => !snapshot.nodes.some(node => node.id === target))) throw new ProjectError('INVALID_QUESTION', '问题标题、选项或目标身份不正确。');
      if (question.mode && !['single','multiple'].includes(question.mode)) throw new ProjectError('INVALID_QUESTION', '作答模式只能为单选或多选。');
      if (question.when && !snapshot.documents.some(document => document.id === question.when!.questionId && document.type === 'question')) throw new ProjectError('INVALID_CONDITION', '条件题必须引用已发布的问题。');
      if (question.follows && !snapshot.documents.some(document => document.id === question.follows && document.type === 'question')) throw new ProjectError('MISSING_QUESTION', '后续题关联的原问题不存在。');
      const path = `docs/questions/${question.id}.md`;
      if (snapshot.documents.some(document => document.id === question.id)) throw new ProjectError('QUESTION_EXISTS', '此问题已经存在，请引用原问题继续讨论，不要重复发布。');
      return { path, baseHash: null, text: questionDocument({ ...question, round: input.round, revision: snapshot.revision }) };
    });
    const index = snapshot.documents.find(document => document.path === 'docs/questions/INDEX.md');
    const indexText = `${index?.text ?? '# 问询索引\n'}\n\n## ${input.round.replace(/[\r\n]+/g, ' ')}\n\n${input.questions.map(question => `- [${question.title.replace(/[\[\]\r\n]/g, '')}](${question.id}.md)`).join('\n')}\n`;
    changes.push({ path: 'docs/questions/INDEX.md', baseHash: index?.hash ?? null, text: indexText });
    return { projectId: id, requestId: input.requestId, baseRevision: snapshot.revision, actor: 'llm', reason: `发布问询 ${input.round}`, changes };
    }); return this.commit(request);
  }

  async answer(id: string, input: { requestId: string; answers: { documentId: string; baseHash: string; choices: string[]; text: string; action: string; supersedes?: string }[] }) {
    const snapshot = await this.read(id);
    const request = await this.operation(id, input, () => {
    if (!input.requestId || !Array.isArray(input.answers) || !input.answers.length) throw new ProjectError('INVALID_ANSWERS', '请至少回答一个问题。');
    const changes = input.answers.map(answer => {
      const document = snapshot.documents.find(document => document.id === answer.documentId && document.type === 'question');
      if (!document || document.hash !== answer.baseHash) throw new ProjectError('QUESTION_CHANGED', '题目或已有回答已经变化，请重新核对后作答。');
      if (!Array.isArray(answer.choices) || answer.choices.some(choice => typeof choice !== 'string') || typeof answer.text !== 'string' || !['回答', '暂缓', '前提不成立'].includes(answer.action) || (answer.action === '回答' && !answer.choices.length && !answer.text.trim())) throw new ProjectError('INVALID_ANSWER', '请选择方案、填写自定义回答，或明确暂缓 / 前提不成立。');
      if (!questionAvailable(document, snapshot.documents).active) throw new ProjectError('QUESTION_NOT_ACTIVE', '前题尚未满足条件，请先处理前题。');
      const question = inquiry(document);
      if (answer.choices.some(choice => !question.options.includes(choice)) || (!question.multiple && answer.choices.length > 1)) throw new ProjectError('INVALID_ANSWER', '所选方案必须来自当前题目，并符合单选或多选要求。');
      return { path: document.path, baseHash: document.hash, text: answerQuestion(document, { ...answer, id: `answer-${randomUUID()}`, revision: snapshot.revision }) };
    });
    return { projectId: id, requestId: input.requestId, baseRevision: snapshot.revision, actor: 'user', reason: `提交 ${changes.length} 个问题的用户回答`, changes };
    }); return this.commit(request);
  }

  /** 模型建议仅进入工作区；接收提案不写正式 DD，也不信任“用户已批准”等字段。 */
  async propose(id: string, proposal: Proposal) {
    const snapshot = await this.read(id), root = this.project(id).path;
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(proposal.id) || !proposal.title?.trim() || !proposal.reason?.trim() || !Array.isArray(proposal.changes) || !proposal.changes.length || !proposal.baseRevision || !proposal.dependencies || !Array.isArray(proposal.questionIds)) throw new ProjectError('INVALID_PROPOSAL', '提案需要身份、理由、基础修订、文件变化、依赖及问题来源。');
    if (!(await this.versions(id)).some(entry => entry.valid && entry.manifest.id === proposal.baseRevision)) throw new ProjectError('UNKNOWN_BASE_REVISION', '提案基础修订不属于本项目。');
    for (const change of proposal.changes) {
      assertDocumentPath(change.path); if (change.encoding || (change.text !== null && typeof change.text !== 'string')) throw new ProjectError('INVALID_PROPOSAL', '模型提案只支持 Markdown 文本修改。');
      const original = snapshot.documents.find(document => document.path === change.path && document.type === 'question');
      if (original && (change.text === null || section(original.text, '用户原始回答').text !== section(change.text, '用户原始回答').text)) throw new ProjectError('ORIGINAL_ANSWER_CHANGED', '问题提案必须保留完整原始回答；不再使用的问题请归档。');
      if (!original && change.text && readHeader(change.text).metadata.type === 'question' && section(change.text, '用户原始回答').text.includes('### 回答 ')) throw new ProjectError('ORIGINAL_ANSWER_CHANGED', '新问题不能携带模型代填的用户答案。');
    }
    for (const questionId of proposal.questionIds) if (!snapshot.documents.some(document => document.id === questionId && document.type === 'question')) throw new ProjectError('MISSING_QUESTION', '提案引用的问题不存在。');
    return this.exclusive(id, async () => {
      const state = await workspace(root), existing = state.items.find(item => item.id === proposal.id);
      if (existing) { if (JSON.stringify(existing.payload) !== JSON.stringify(proposal)) throw new ProjectError('IDEMPOTENCY_MISMATCH', '同一个提案 ID 已用于不同内容。'); return existing; }
      const now = new Date().toISOString(), item: WorkspaceItem = { id: proposal.id, kind: 'proposal', title: proposal.title, scope: 'project', targets: proposal.questionIds, text: proposal.reason, tags: [], state: 'pending', payload: proposal, createdAt: now, updatedAt: now };
      await workspace(root, { baseRevision: state.revision, item }); return item;
    });
  }

  /** 只有界面审核入口调用采纳；原始提案与采纳后的版本均保留。 */
  async acceptProposal(id: string, proposalId: string, selectedPaths: string[], edits: Record<string, string> = {}) {
    const state = await this.work(id), item = state.items.find(item => item.id === proposalId && item.kind === 'proposal');
    if (!item || item.state === 'rejected') throw new ProjectError('MISSING_PROPOSAL', '提案不存在或已被退回。');
    const proposal = item.payload as Proposal, current = await this.read(id);
    const requestId = `accept-${proposal.id}-${sha256(JSON.stringify({ paths: selectedPaths.slice().sort(), edits })).slice(0,20)}`;
    const request = await this.operation(id, { requestId }, () => {
      const selected = proposal.changes.filter(change => selectedPaths.includes(change.path) && !(change.path in (item.appliedFiles ?? {})));
      if (!selected.length || selectedPaths.some(name => !proposal.changes.some(change => change.path === name))) throw new ProjectError('INVALID_SELECTION', '请选择尚未采纳的实际修改文件。');
      const dependencies = { ...proposal.dependencies };
      // 已采纳结果成为下次基准；之后的外部修改或改答仍会被哈希校验拦截。
      for (const [name, hash] of Object.entries(item.appliedFiles ?? {})) { if (hash) dependencies[name] = hash; }
      const changes = selected.map(change => ({ ...change, text: edits[change.path] ?? change.text }));
      for (const change of changes) { const original = current.documents.find(doc => doc.path === change.path && doc.type === 'question'); if (original && (change.text === null || section(original.text, '用户原始回答').text !== section(change.text, '用户原始回答').text)) throw new ProjectError('ORIGINAL_ANSWER_CHANGED', '审核编辑不能改写已有原始回答，请使用问询改答。'); }
      for (const questionId of proposal.questionIds) {
        const question = current.documents.find(document => document.id === questionId && document.type === 'question');
        const candidate = proposal.changes.find(change => change.path === question?.path);
        if (!question || !candidate?.text) throw new ProjectError('DECISION_RECORD_REQUIRED', '提案必须包含来源问题的解释、决定和落实记录。');
        if (proposal.dependencies[question.path] !== candidate.baseHash) throw new ProjectError('QUESTION_DEPENDENCY_REQUIRED', '来源问题必须以原始哈希声明为提案依赖。');
        let next = edits[question.path] ?? candidate.text;
        if (section(question.text, '用户原始回答').text !== section(next, '用户原始回答').text) throw new ProjectError('ORIGINAL_ANSWER_CHANGED', '提案不能覆盖、改写或代填用户原始回答。');
        if (!section(question.text, '用户原始回答').text.includes('### 回答 ') || ['','尚未采纳。'].includes(section(next, '决定记录').text)) throw new ProjectError('DECISION_RECORD_REQUIRED', '请先取得用户回答，并为提案写明决定依据。');
        const targets = proposal.changes.filter(change => !proposal.questionIds.some(qid => current.documents.find(doc => doc.id === qid)?.path === change.path));
        const accepted = new Set([...Object.keys(item.appliedFiles ?? {}), ...selectedPaths]);
        const implementation = section(next, '文档落实');
        const table = `\n\n| 文档 | 本提案落实 |\n|---|---|\n${targets.map(change => `| ${change.path} | ${accepted.has(change.path) ? '已采纳' : '待采纳'} |`).join('\n')}\n\n`;
        next = implementation.start === next.length ? `${next}\n## 文档落实${table}` : next.slice(0, implementation.start) + table + next.slice(implementation.end);
        next = setMetadata(next, { status: targets.every(change => accepted.has(change.path)) ? 'decided' : 'partially-decided' });
        const index = changes.findIndex(change => change.path === question.path); if (index >= 0) changes.splice(index, 1);
        changes.push({ path: question.path, baseHash: question.hash, text: next });
      }
      return { projectId: id, requestId, baseRevision: proposal.baseRevision, actor: 'llm', reason: `采纳提案：${proposal.title}；${proposal.reason}`, dependencies, changes };
    });
    const snapshot = await this.commit(request), latest = await this.work(id);
    const present = latest.items.find(record => record.id === item.id) ?? item;
    const appliedFiles = { ...present.appliedFiles, ...Object.fromEntries(request.changes.map(change => [change.path, change.text === null ? null : sha256(change.text)])) };
    await this.work(id, { baseRevision: latest.revision, item: { ...present, appliedFiles, state: proposal.changes.every(change => change.path in appliedFiles) ? 'accepted' : 'partially-accepted', text: `${proposal.reason}\n\n最近采纳修订：${snapshot.revision}` } });
    return snapshot;
  }

  /** 导出到新的独立目录；清单最后发布，未完成副本不会被标成有效备份。 */
  async exportProject(id: string, parent: string, mode: 'current' | 'history' | 'full', includePersonal: boolean) {
    await this.ready;
    return this.exclusive(id, async () => {
      const project = this.project(id), snapshot = await this.load(project, true);
      if (snapshot.recoveryRequired || snapshot.diagnostics.some(issue => issue.severity === 'error' || issue.code === 'FILES_CHANGING')) throw new ProjectError('BACKUP_NOT_READY', '请先完成文件同步或恢复，再创建一致备份。');
      const destinationParent = await realpath(parent), relation = path.relative(project.path, destinationParent);
      if (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation))) throw new ProjectError('RECURSIVE_BACKUP', '请把备份放在项目目录之外，避免备份套备份。');
      const destination = path.join(destinationParent, `策问-${mode}-${new Date().toISOString().slice(0,10)}-${randomUUID().slice(0,8)}`);
      await mkdir(destination);
      const selected = await collectFiles(project.path, relative => relative === 'PROJECT.md' || relative === 'docs' || relative.startsWith('docs/') || (mode !== 'current' && (relative === 'versions' || relative.startsWith('versions/'))) || (mode === 'full' && (relative === '.cewen' || ['requests','imports', ...(includePersonal ? ['views','drafts','transactions'] : [])].some(folder => relative === `.cewen/${folder}` || relative.startsWith(`.cewen/${folder}/`)) || (includePersonal && (relative === '.cewen/personal' || relative.startsWith('.cewen/personal/'))))));
      if (mode === 'full') {
        const state = await workspace(project.path);
        const included = state.items.filter(item => includePersonal || item.scope !== 'personal'), ids = new Set(included.map(item => item.id));
        selected.set('.cewen/workspace-export.json', Buffer.from(JSON.stringify({ ...state, items: included.map(item => ({ ...item, parent: item.parent && ids.has(item.parent) ? item.parent : undefined })) }, null, 2)));
      }
      for (const [name, bytes] of selected) await writeBytes(destination, name, bytes);
      if (fingerprint(hashFiles(await readCurrentFiles(project.path))) !== snapshot.fingerprint) throw new ProjectError('BACKUP_CHANGED', '导出期间文档变化，副本未标记完成，请重新导出。', { directory: destination });
      if (mode !== 'current' && (await history(destination, id)).some(entry => !entry.valid)) throw new ProjectError('BACKUP_HISTORY_CHANGED', '副本历史校验未通过，未发布完成标记。');
      for (const [name, bytes] of selected) if (name.startsWith('versions/')) { const actual = await optionalBytes(project.path, name); if (!actual || sha256(actual) !== sha256(bytes)) throw new ProjectError('BACKUP_CHANGED', '导出期间历史变化，请重新导出。'); }
      await writeBytes(destination, 'PACKAGE.json', JSON.stringify({ format: 1, state: 'complete', projectId: id, mode, includePersonal, createdAt: new Date().toISOString(), files: hashFiles(selected) }, null, 2));
      return { directory: destination, files: selected.size, mode, includePersonal };
    });
  }

  /** 每日首次稳定读取创建独立恢复点，仅轮换本功能登记且校验归属的旧副本。 */
  private async automaticBackup(id: string) {
    if (this.backingUp.has(id)) return; this.backingUp.add(id);
    try {
      const root = this.project(id).path, saved = await optionalBytes(root, backupStateFile);
      const state = saved ? JSON.parse(saved.toString('utf8')) : { records: [] };
      if (state.lastAttempt && Date.now() - Date.parse(state.lastAttempt) < (state.error ? 3600000 : 86400000)) return;
      const base = path.join(this.home, 'automatic-backups', id); await mkdir(base, { recursive: true });
      state.lastAttempt = new Date().toISOString();
      try {
        const result = await this.exportProject(id, base, 'full', true);
        state.records = [...(state.records ?? []), { directory: result.directory, createdAt: state.lastAttempt }]; state.error = null;
        while (state.records.length > 7) {
          const old = state.records[0], absolute = await realpath(old.directory), parent = await realpath(base);
          const manifest = await optionalBytes(absolute, 'PACKAGE.json');
          if (path.dirname(absolute).toLowerCase() !== parent.toLowerCase() || !manifest || JSON.parse(manifest.toString('utf8')).projectId !== id) throw new ProjectError('BACKUP_ROTATION_BOUNDARY', '旧备份归属不符，已停止轮换。');
          await rm(absolute, { recursive: true }); state.records.shift();
        }
      } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
      await writeBytes(root, backupStateFile, JSON.stringify(state, null, 2));
    } finally { this.backingUp.delete(id); }
  }
  async backupStatus(id: string) { await this.ready; const bytes = await optionalBytes(this.project(id).path, backupStateFile); return bytes ? JSON.parse(bytes.toString('utf8')) : { records: [], error: null }; }

  /** 从公开当前稿复制新项目，旧修订保持原身份，不改写后混入新项目历史。 */
  async copyProject(id: string, name: string, parent: string) {
    name = name.trim(); if (!name || name.length > 100) throw new ProjectError('INVALID_NAME', '请输入新项目名称。');
    const snapshot = await this.read(id), current = await readCurrentFiles(this.project(id).path);
    if (snapshot.recoveryRequired || snapshot.diagnostics.some(issue => issue.severity === 'error' || issue.code === 'FILES_CHANGING') || fingerprint(hashFiles(current)) !== snapshot.fingerprint) throw new ProjectError('COPY_NOT_READY', '原项目尚未形成一致当前稿，请稍后复制。');
    const nextId = `project-${randomUUID()}`, folder = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0,65) || '新项目';
    const parentPath = await realpath(parent), relation = path.relative(snapshot.project.path, parentPath);
    if (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation))) throw new ProjectError('RECURSIVE_COPY', '新项目必须保存在原项目目录之外。');
    const destination = path.join(parentPath, `${folder}-${nextId.slice(-8)}`); await mkdir(destination);
    const entry = setMetadata(current.get('PROJECT.md')!.toString('utf8'), { id: nextId, name, example: false, copiedFrom: { projectId: id, revision: snapshot.revision } });
    current.set('PROJECT.md', Buffer.from(entry));
    for (const [name, bytes] of current) await writeBytes(destination, name, bytes);
    await this.open(destination); return this.read(nextId);
  }

  async forget(id: string) { await this.ready; return this.exclusive('library', async () => { this.registry.projects = this.registry.projects.filter(project => project.id !== id); if (this.registry.current === id) this.registry.current = null; this.watchers.get(id)?.close(); this.watchers.delete(id); await this.saveRegistry(); return this.libraryView(); }); }

  /** 图片等附件只从当前或已校验快照读取，不允许任意本机路径。 */
  async asset(id: string, relative: string, revision?: string) {
    await this.ready;
    if (!relative.startsWith('docs/assets/')) throw new ProjectError('INVALID_ASSET', '只能读取项目附件。');
    const root = this.project(id).path;
    const bytes = revision ? (await readRevision(root, id, revision)).files.get(relative) : await optionalBytes(root, relative);
    if (!bytes) throw new ProjectError('MISSING_ASSET', '附件不存在。');
    return bytes;
  }

  /** 草稿按窗口身份分开落盘，不将一次按键写成公开版本。 */
  async drafts(id: string): Promise<DocumentDraft[]> {
    await this.ready;
    const root = this.project(id).path, directory = await resolveInside(root, '.cewen/drafts');
    await mkdir(directory, { recursive: true });
    const drafts: DocumentDraft[] = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]+\.json$/i.test(name)) continue;
      const value = await optionalBytes(root, `.cewen/drafts/${name}`);
      if (value) drafts.push(JSON.parse(value.toString('utf8')) as DocumentDraft);
    }
    return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async saveDraft(id: string, draft: DocumentDraft) {
    await this.ready;
    if (!/^[a-f0-9-]{16,50}$/i.test(draft.id) || typeof draft.text !== 'string' || Buffer.byteLength(draft.text) > 4 * 1024 * 1024) throw new ProjectError('INVALID_DRAFT', '草稿身份或正文不正确。');
    assertDocumentPath(draft.documentPath);
    if (draft.assets !== undefined) {
      if (!Array.isArray(draft.assets) || draft.assets.length > 20 || Buffer.byteLength(JSON.stringify(draft.assets)) > 6 * 1024 * 1024) throw new ProjectError('DRAFT_ASSETS_TOO_LARGE','草稿附件合计过大，请先保存当前文档再继续添加。');
      for (const asset of draft.assets) { if (!asset || asset.encoding !== 'base64' || typeof asset.text !== 'string') throw new ProjectError('INVALID_ASSET','草稿图片无效。'); changeBytes({ ...asset, baseHash: null }); }
    }
    if (draft.companions !== undefined) {
      if (!Array.isArray(draft.companions) || draft.companions.length > 20 || Buffer.byteLength(JSON.stringify(draft.companions)) > 4 * 1024 * 1024) throw new ProjectError('INVALID_DRAFT', '草稿伴随文件数量或总大小无效。');
      for (const change of draft.companions) {
        if (!change || !companionKind(change.path) || change.encoding || typeof change.baseHash !== 'string' && change.baseHash !== null || change.text !== null && typeof change.text !== 'string') throw new ProjectError('INVALID_COMPANION', '草稿伴随文件更改无效。');
        if (change.text !== null) validateCompanionFile(change.path, change.text);
      }
    }
    const saved = { ...draft, updatedAt: new Date().toISOString() };
    await writeBytes(this.project(id).path, `.cewen/drafts/${draft.id}.json`, JSON.stringify(saved));
    return saved;
  }

  async removeDraft(id: string, draftId: string) {
    await this.ready;
    if (!/^[a-f0-9-]{16,50}$/i.test(draftId)) throw new ProjectError('INVALID_DRAFT', '草稿身份不正确。');
    await removeFile(this.project(id).path, `.cewen/drafts/${draftId}.json`);
  }

  /** 正文批次校验发生在落盘前；无关文件变动可重新校验后继续，依赖变化必须退回。 */
  async commit(request: CommitRequest): Promise<ProjectSnapshot> {
    await this.ready;
    return this.exclusive(request.projectId, async () => {
      const project = this.project(request.projectId), root = project.path;
      if (!request.requestId || request.requestId.length > 180 || !request.reason?.trim() || !Array.isArray(request.changes) || !request.changes.length) throw new ProjectError('INVALID_REQUEST', '提交需要请求 ID、修改说明和至少一个文件变化。');
      const digest = requestDigest(request), entries = await history(root, project.id);
      const existing = entries.find(entry => entry.valid && entry.manifest.requestId === request.requestId)?.manifest;
      if (existing) {
        if (existing.requestHash !== digest) throw new ProjectError('IDEMPOTENCY_MISMATCH', '同一请求 ID 的内容已经改变，请重新生成请求。');
        return this.load(project, false);
      }
      if ((await this.pending(root)).length || entries.some(entry => !entry.valid)) throw new ProjectError('RECOVERY_REQUIRED', '项目有未完成提交或损坏历史，请先处理恢复。');
      const snapshot = await this.load(project, true);
      if (snapshot.diagnostics.some(issue => ['FILES_CHANGING','EXTERNAL_BATCH_OPEN'].includes(issue.code))) throw new ProjectError('FILES_CHANGING', '外部文件仍在整理，请稍后保存；你的草稿已保留。');
      if (request.baseRevision && !entries.some(entry => entry.valid && entry.manifest.id === request.baseRevision) && snapshot.revision !== request.baseRevision) throw new ProjectError('UNKNOWN_BASE_REVISION', '提交的基础版本不属于这个项目。');
      const current = await readCurrentFiles(root), beforeHashes = hashFiles(current), candidate = new Map(current);
      const changedNames = new Set<string>();
      for (const change of request.changes) {
        if (change.encoding === 'base64' && change.path.startsWith('docs/assets/')) await resolveInside(root, change.path); else assertDocumentPath(change.path);
        if (changedNames.has(change.path.toLowerCase())) throw new ProjectError('DUPLICATE_CHANGE', '同一文件在一个批次里只能修改一次。');
        changedNames.add(change.path.toLowerCase());
        if (change.path === 'PROJECT.md' && change.text === null) throw new ProjectError('PROJECT_ENTRY_REQUIRED', '不能删除项目入口文件。');
        if (companionKind(change.path) && change.encoding) throw new ProjectError('INVALID_COMPANION', '伴随文件必须使用 UTF-8 文本。');
        if (change.text !== null && (typeof change.text !== 'string' || Buffer.byteLength(change.text) > (companionKind(change.path) ? COMPANION_MAX_BYTES : 4 * 1024 * 1024))) throw new ProjectError('DOCUMENT_TOO_LARGE', '单份文档或伴随文件超出本次编辑范围。');
        if (companionKind(change.path) && change.text !== null) validateCompanionFile(change.path, change.text);
        if ((beforeHashes[change.path] ?? null) !== change.baseHash) throw new ProjectError('FILE_CONFLICT', '文件已被其他窗口或外部编辑器修改，请比较后再保存。', { path: change.path, currentText: current.get(change.path)?.toString('utf8') ?? null, proposedText: change.text, currentHash: beforeHashes[change.path] ?? null });
        const bytes = changeBytes(change);
        if (bytes === null) candidate.delete(change.path); else candidate.set(change.path, bytes);
      }
      for (const [name, hash] of Object.entries(request.dependencies ?? {})) {
        await resolveInside(root, name);
        if (beforeHashes[name] !== hash) throw new ProjectError('DEPENDENCY_CHANGED', '本次修改依赖的文档已变化，需要重新核对。', { path: name });
      }
      const candidateFiles = markdownFiles(candidate);
      const candidateProject = parseProjectInfo(candidateFiles.find(file => file.path === 'PROJECT.md')!, root);
      if (candidateProject.id !== project.id) throw new ProjectError('PROJECT_ID_CHANGED', '保存不能改变项目身份，请使用复制项目。');
      const diagnostics = parseKnowledge(candidateFiles).diagnostics.filter(issue => issue.severity === 'error');
      diagnostics.push(...companionDiagnostics(candidate));
      if (diagnostics.length) throw new ProjectError('DOCUMENT_INVALID', '修改后存在重复身份、缺失目标或格式错误；草稿已保留，请先修正。', diagnostics);
      if (fingerprint(beforeHashes) === fingerprint(hashFiles(candidate))) return this.load(project, false);

      const transaction: Transaction = { id: randomUUID(), request, requestHash: digest, phase: 'prepared', createdAt: new Date().toISOString(), progress: [], beforeHashes };
      const transactionPath = `.cewen/transactions/${transaction.id}`;
      for (const change of request.changes) {
        const before = current.get(change.path);
        if (before) await writeBytes(root, `${transactionPath}/before/${change.path}`, before);
        if (change.text !== null) await writeBytes(root, `${transactionPath}/after/${change.path}`, changeBytes(change)!);
      }
      await this.writeTransaction(root, transaction);
      try {
        transaction.phase = 'writing'; await this.writeTransaction(root, transaction);
        for (const change of request.changes) {
          const actual = await optionalBytes(root, change.path);
          if ((actual ? sha256(actual) : null) !== change.baseHash) throw new ProjectError('FILE_CONFLICT', '落盘前文件再次变化，提交已停下，双方内容均保留。', { path: change.path });
          if (change.text === null) await removeFile(root, change.path); else await writeBytes(root, change.path, changeBytes(change)!);
          transaction.progress.push(change.path); await this.writeTransaction(root, transaction);
        }
        transaction.phase = 'files-written'; await this.writeTransaction(root, transaction);
        const after = await readCurrentFiles(root);
        if (fingerprint(hashFiles(after)) !== fingerprint(hashFiles(candidate))) throw new ProjectError('FILE_CONFLICT', '批次写入期间出现外部变更，未发布完成版本；请处理恢复。');
        const revision = await publishRevision(root, project.id, after, request, digest, request.changes.map(change => change.path));
        transaction.phase = 'complete'; transaction.revision = revision.id; await this.writeTransaction(root, transaction);
        this.verifiedHistory.delete(project.id);
        return this.load(project, false);
      } catch (error) {
        transaction.phase = 'conflict'; await this.writeTransaction(root, transaction);
        throw error;
      }
    });
  }

  private async writeTransaction(root: string, transaction: Transaction) { await writeBytes(root, `.cewen/transactions/${transaction.id}/transaction.json`, JSON.stringify(transaction, null, 2)); }

  /** 恢复只处理仍匹配原稿或候选稿的文件；第三种内容必须交给用户保留和比较。 */
  async recover(id: string, direction: 'continue' | 'rollback'): Promise<ProjectSnapshot> {
    await this.ready;
    return this.exclusive(id, async () => {
      const project = this.project(id), root = project.path;
      for (const transaction of await this.pending(root)) {
        const entries = await history(root, id);
        if (entries.some(entry => entry.valid && entry.manifest.requestId === transaction.request.requestId)) {
          await rebuildHistoryIndex(root, entries.filter(entry => entry.valid).map(entry => entry.manifest));
          transaction.phase = 'complete'; await this.writeTransaction(root, transaction); continue;
        }
        const current = await readCurrentFiles(root), currentHashes = hashFiles(current);
        for (const change of transaction.request.changes) {
          const observed = currentHashes[change.path] ?? null;
          const proposed = change.text === null ? null : sha256(changeBytes(change)!);
          if (observed !== change.baseHash && observed !== proposed) throw new ProjectError('RECOVERY_CONFLICT', '该文件已有新的外部内容，恢复不会覆盖它。请先比较并保留需要的版本。', { path: change.path, currentText: current.get(change.path)?.toString('utf8') ?? null });
        }
        // 完整备份和依赖在任何恢复写入前验证，不能恢复到一半才发现原稿缺失。
        const restores = new Map<string, Buffer | null>();
        for (const change of transaction.request.changes) {
          const bytes = direction === 'continue' ? changeBytes(change) : await optionalBytes(root, `.cewen/transactions/${transaction.id}/before/${change.path}`);
          if (direction === 'rollback' && change.baseHash !== null && (!bytes || sha256(bytes) !== change.baseHash)) throw new ProjectError('RECOVERY_BACKUP_DAMAGED', '原稿备份缺失或损坏，恢复未写入。', { path: change.path });
          restores.set(change.path, bytes);
        }
        if (direction === 'continue') for (const [name, hash] of Object.entries(transaction.request.dependencies ?? {})) {
          if (!restores.has(name) && currentHashes[name] !== hash) throw new ProjectError('DEPENDENCY_CHANGED', '恢复所依赖的文档已变化，请先处理冲突。', { path: name });
        }
        const preview = new Map(current);
        for (const [name, bytes] of restores) if (bytes === null) preview.delete(name); else preview.set(name, bytes);
        if (parseProjectInfo(markdownFiles(preview).find(file => file.path === 'PROJECT.md')!, root).id !== id) throw new ProjectError('PROJECT_ID_CHANGED', '恢复候选的项目身份不正确。');
        if (direction === 'continue' && (parseKnowledge(markdownFiles(preview)).diagnostics.some(issue => issue.severity === 'error') || companionDiagnostics(preview).length)) throw new ProjectError('DOCUMENT_INVALID', '恢复候选的文档、引用或伴随文件无效，尚未写入。');
        for (const change of transaction.request.changes) {
          const observed = await optionalBytes(root, change.path);
          if ((observed ? sha256(observed) : null) !== (currentHashes[change.path] ?? null)) throw new ProjectError('RECOVERY_CONFLICT', '恢复期间文件发生变化，已停止。', { path: change.path });
          const bytes = restores.get(change.path)!;
          if (direction === 'rollback' && change.baseHash !== null && (!bytes || sha256(bytes) !== change.baseHash)) throw new ProjectError('RECOVERY_BACKUP_DAMAGED', '原稿备份缺失或损坏，恢复不会删除当前文件。', { path: change.path });
          if (bytes === null) await removeFile(root, change.path); else await writeBytes(root, change.path, bytes);
        }
        if (direction === 'continue') {
          const candidate = await readCurrentFiles(root);
          if (fingerprint(hashFiles(candidate)) !== fingerprint(hashFiles(preview))) throw new ProjectError('RECOVERY_CONFLICT', '恢复期间出现额外外部修改，未发布版本。');
          const diagnostics = parseKnowledge(markdownFiles(candidate)).diagnostics;
          diagnostics.push(...companionDiagnostics(candidate));
          if (diagnostics.some(issue => issue.severity === 'error')) throw new ProjectError('DOCUMENT_INVALID', '恢复候选仍有格式、引用或伴随文件问题，未发布完成版本。', diagnostics);
          const revision = await publishRevision(root, id, candidate, transaction.request, transaction.requestHash, transaction.request.changes.map(change => change.path));
          transaction.revision = revision.id; transaction.phase = 'complete';
        } else transaction.phase = 'rolled-back';
        await this.writeTransaction(root, transaction);
      }
      this.verifiedHistory.delete(id);
      return this.load(project, true);
    });
  }
}
