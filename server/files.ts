import { createHash, randomUUID, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, path, Buffer, runtimeKind, runtimePid, ownerAlive, runtimeLock } from './platform.ts';

/** 本地文件错误携带稳定代码，界面能保留用户稿并给出中文处理建议。 */
export class ProjectError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.code = code; this.details = details; }
}

/** 哈希基于实际字节，不能用修改时间或显示名称代替内容身份。 */
export function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
/** 清单按相对路径排序，操作系统枚举顺序不影响项目指纹。 */
export function fingerprint(files: Record<string, string>) {
  return sha256(JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
}

/** 公开文件统一使用斜杠；拒绝上跳、设备名、盘符和 Windows 隐含改名。 */
export function validateRelative(relative: string) {
  if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new ProjectError('INVALID_PATH', '文件路径必须是项目内的正常相对路径。', { path: relative });
  }
  return relative;
}

/** 项目内部不跟随链接，防止文档或附件把读写引向其他工作目录。 */
export async function resolveInside(root: string, relative: string) {
  validateRelative(relative);
  const canonicalRoot = await realpath(root);
  const destination = path.resolve(canonicalRoot, ...relative.split('/'));
  const check = path.relative(canonicalRoot, destination);
  if (!check || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) throw new ProjectError('INVALID_PATH', '目标超出项目目录。');
  let cursor = canonicalRoot;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new ProjectError('LINK_NOT_ALLOWED', '项目内部的符号链接不能作为文档读写目标。', { path: relative });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return destination;
}

/** 可选文件读取；权限错误与损坏不能伪装成文件不存在。 */
export async function optionalBytes(root: string, relative: string): Promise<Buffer | null> {
  try { return await readFile(await resolveInside(root, relative)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** 写入同目录临时文件并替换单个目标；多文件的恢复由提交日志负责。 */
export async function writeBytes(root: string, relative: string, bytes: Buffer | string) {
  const destination = await resolveInside(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.cewen-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, destination); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** 删除仅处理已经核对过的单个项目文件，永不递归删除用户目录。 */
export async function removeFile(root: string, relative: string) {
  try { await unlink(await resolveInside(root, relative)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** 只枚举公开当前稿；版本和编辑器私有记录不会混入策划正文。 */
export async function readCurrentFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const entry = await optionalBytes(root, 'PROJECT.md');
  if (!entry) throw new ProjectError('MISSING_PROJECT', '该目录没有 PROJECT.md，请先创建项目或使用导入流程。');
  files.set('PROJECT.md', entry);
  async function walk(relative: string) {
    const directory = await resolveInside(root, relative);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp') || entry.name.startsWith('.')) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new ProjectError('LINK_NOT_ALLOWED', '当前文档中含有指向其他位置的链接，请使用普通文件。', { path: child });
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.set(child, await readFile(await resolveInside(root, child)));
    }
  }
  await walk('docs');
  return files;
}

/** 清单包括附件，因此历史快照不会悄悄沿用后来替换的图片。 */
export function hashFiles(files: Map<string, Buffer>) {
  return Object.fromEntries([...files].map(([name, content]) => [name, sha256(content)]));
}

/** 常见受控写入只允许当前 Markdown，不能用提交接口覆盖历史或编辑器数据库。 */
export function assertDocumentPath(relative: string) {
  validateRelative(relative);
  if (relative !== 'PROJECT.md' && (!relative.startsWith('docs/') || !relative.endsWith('.md'))) throw new ProjectError('INVALID_DOCUMENT_PATH', '正文修改仅允许 PROJECT.md 或 docs 下的 Markdown 文件。');
}

/** 多个宿主访问同一项目时使用短期文件锁；外部文本编辑仍由内容哈希保护。 */
export async function withProjectLock<T>(root: string, action: () => Promise<T>): Promise<T> { return runtimeLock(root, () => fileLock(root, action)); }
async function fileLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const target = await resolveInside(root, '.cewen/project.lock'); await mkdir(path.dirname(target), { recursive: true });
  const token = randomUUID(), deadline = Date.now() + 5000;
  /** 释放或接管前只认完整的所有者记录，不用损坏 JSON 覆盖真正的操作结果。 */
  const parseOwner = (bytes: Buffer | null): { pid: number; token: string; kind?: string; expiresAt?: number } | undefined => {
    try { const value = JSON.parse(bytes?.toString('utf8') ?? 'null'); if (Number.isInteger(value?.pid) && value.pid > 0 && typeof value.token === 'string') return value; } catch { /* 创建中的记录可能暂时不完整。 */ }
    return undefined;
  };
  while (true) {
    try { const handle = await open(target, 'wx'); try { await handle.writeFile(JSON.stringify({ pid: runtimePid, token, kind: runtimeKind, expiresAt: Date.now() + 30000 })); await handle.sync(); } finally { await handle.close(); } break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = parseOwner(await readFile(target).catch(() => null));
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { if (owner.kind === 'web' ? Number(owner.expiresAt) < Date.now() : !ownerAlive(owner.pid)) throw Object.assign(new Error('锁所有者已结束'), { code: 'ESRCH' }); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') { const check = parseOwner(await readFile(target).catch(() => null)); if (check?.token === owner.token) await unlink(target).catch(() => {}); continue; } }
      }
      if (Date.now() >= deadline) throw new ProjectError(owner ? 'PROJECT_BUSY' : 'LOCK_DAMAGED', owner ? '另一策问进程正在处理这个项目，请稍后重试。' : '项目锁记录不完整。请先关闭所有访问此项目的策问服务，再将 .cewen/project.lock 移出项目后重新打开；文档与草稿未被修改。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // 等待已开始的续租结束后再释放，避免最后一次异步写入复活过期锁。
  let renewing: Promise<void> = Promise.resolve();
  const heartbeat = runtimeKind === 'web' ? setInterval(() => {
    renewing = renewing.then(async () => { const current = parseOwner(await readFile(target).catch(() => null)); if (current?.token === token) await writeBytes(root, '.cewen/project.lock', JSON.stringify({ pid: runtimePid, token, kind: runtimeKind, expiresAt: Date.now() + 30000 })); }).catch(() => {});
  }, 10000) : undefined;
  try { return await action(); }
  finally { clearInterval(heartbeat); await renewing; const current = parseOwner(await readFile(target).catch(() => null)); if (current?.token === token) await unlink(target); }
}
