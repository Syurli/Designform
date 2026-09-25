import path from 'path-browserify';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import type { WorkspaceState } from '../shared/model.ts';

export { path, Buffer };
export const randomUUID = () => crypto.randomUUID();
export const runtimeKind: 'desktop' | 'web' = 'web';
export const runtimePid = 1;
export const defaultTemplateRoot = '/app/templates/example';
export const backupStateFile = '.cewen/backup-state.web.json';
export const ownerAlive = (_pid: number) => true;
export type FSWatcher = { close(): void; on(event: string, action: () => void): void };
/** 浏览器没有可靠的文件监听，复用工作台的定期哈希扫描。 */
export function watch(..._args: unknown[]): FSWatcher { throw new Error('使用定期扫描'); }
/** 同一来源的多个网页串行访问项目；跨桌面进程仍应避免同时打开同一项目。 */
export async function runtimeLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`designform:${root}`, action);
}
export function createHash(_algorithm: string) {
  return { update(value: string | Uint8Array) { return { digest(_encoding: string) { return Buffer.from(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value)).toString('hex'); } }; } };
}

type Directory = FileSystemDirectoryHandle & { queryPermission(options: { mode: string }): Promise<PermissionState>; requestPermission(options: { mode: string }): Promise<PermissionState>; entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: string; id: string }) => Promise<Directory> };
const mounts = new Map<string, Directory>();
let ready: Promise<void> | undefined;
let exampleReady: Promise<void> | undefined;
let database: IDBDatabase;
/** IndexedDB 仅保存用户授权的句柄；正文始终直接读取文件夹。 */
function databaseReady(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('designform-folders', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function initialize() {
  database = await databaseReady();
  const records = await new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
    const transaction = database.transaction('handles'), store = transaction.objectStore('handles');
    const keys = store.getAllKeys(), values = store.getAll();
    transaction.oncomplete = () => resolve([keys.result, values.result]); transaction.onerror = () => reject(transaction.error);
  });
  records[0].forEach((key, index) => mounts.set(String(key), records[1][index] as Directory));
  mounts.set('/app', await navigator.storage.getDirectory() as Directory);
  await directory('/app/projects', true);
}
export function initializeFilesystem() { return ready ??= initialize(); }
/** 内置基础示例平时直接从发行资源预览；仅用户明确创建练习副本时才写入浏览器文件系统。 */
export async function ensureExampleTemplate() {
  await initializeFilesystem();
  exampleReady ??= (async () => {
    const sources = import.meta.glob('../templates/example/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    for (const [name, content] of Object.entries(sources)) {
      const destination = `/app/templates/example/${name.split('/templates/example/')[1]}`;
      await rawWrite(destination, Buffer.from(content));
    }
  })().catch(error => { exampleReady = undefined; throw error; });
  return exampleReady;
}
function ioError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
function translate(error: unknown): never {
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') throw ioError('ENOENT', '文件或目录不存在。');
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') throw ioError('PERMISSION_REQUIRED', '文件夹授权已失效，请在项目中心重新选择同一个文件夹。');
    if (error.name === 'QuotaExceededError') throw ioError('STORAGE_FULL', '本地存储空间不足，请导出备份并释放空间后重试。');
  }
  throw error;
}
function mounted(filename: string) {
  if (!filename.startsWith('/') || filename.includes('\\') || filename.split('/').includes('..')) throw ioError('INVALID_PATH', '文件路径超出已授权目录。');
  const normalized = path.resolve(filename), prefix = [...mounts.keys()].sort((a,b) => b.length-a.length).find(key => normalized === key || normalized.startsWith(key + '/'));
  if (!prefix) throw ioError('PERMISSION_REQUIRED', '请先选择并授权这个文件夹。');
  return { handle: mounts.get(prefix)!, parts: normalized.slice(prefix.length).split('/').filter(Boolean) };
}
async function directory(filename: string, create = false): Promise<Directory> {
  try { const { handle, parts } = mounted(filename); let result = handle; for (const part of parts) result = await result.getDirectoryHandle(part, { create }) as Directory; return result; } catch (error) { return translate(error); }
}
async function file(filename: string, create = false) {
  try { return await (await directory(path.dirname(filename))).getFileHandle(path.basename(filename), { create }); } catch (error) { return translate(error); }
}
async function rawWrite(filename: string, value: Uint8Array) {
  await directory(path.dirname(filename), true);
  const target = await file(filename, true), writer = await target.createWritable();
  try { await writer.write(new Uint8Array(value)); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); translate(error); }
}
/** 只在原始点击栈调用选择器，不在异步操作之后请求浏览器弹窗。 */
export function chooseDirectory(): Promise<string> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return Promise.reject(ioError('BROWSER_UNSUPPORTED', '本机文件夹读写需要桌面版 Chrome 或 Edge。也可以下载策问桌面版。'));
  const selection = picker.call(window, { mode: 'readwrite', id: 'designform-projects' });
  return selection.then(async handle => {
    await initializeFilesystem();
    // 父目录和子目录统一入口，避免同一物理项目因重复选择而被误认成副本。
    for (const [prefix, saved] of mounts) {
      if (prefix === '/app') continue;
      if (await saved.isSameEntry(handle)) return prefix;
      const relative = await saved.resolve(handle).catch(() => null);
      if (relative) return path.join(prefix, ...relative);
    }
    const key = `/folders/${randomUUID()}/${handle.name}`;
    await new Promise<void>((resolve, reject) => { const tx = database.transaction('handles','readwrite'); tx.objectStore('handles').put(handle, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    mounts.set(key, handle); return key;
  });
}
/** 用户点击最近项目时立即触发再次授权；浏览器可能每次会话都要求授权。 */
export function requestDirectoryPermission(filename: string): Promise<void> {
  try {
    if (filename.startsWith('/app/')) return Promise.resolve();
    const handle = mounted(filename).handle;
    return handle.requestPermission({ mode: 'readwrite' }).then(state => { if (state !== 'granted') throw ioError('PERMISSION_REQUIRED', '未取得文件夹读写授权，原文件没有修改。'); });
  } catch (error) { return Promise.reject(error); }
}
export async function realpath(filename: string) { await initializeFilesystem(); await directory(filename); return path.resolve(filename); }
export async function mkdir(filename: string, options: { recursive?: boolean } = {}) {
  await initializeFilesystem();
  if (!options.recursive) { try { await lstat(filename); throw ioError('EEXIST', '目标目录已经存在。'); } catch (error) { if ((error as {code?:string}).code !== 'ENOENT') throw error; } }
  if (options.recursive) await directory(filename, true);
  else await (await directory(path.dirname(filename))).getDirectoryHandle(path.basename(filename), { create: true });
}
type Entry = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
export function readdir(filename: string): Promise<string[]>;
export function readdir(filename: string, options: { withFileTypes: true }): Promise<Entry[]>;
export async function readdir(filename: string, options?: { withFileTypes: boolean }): Promise<string[] | Entry[]> {
  await initializeFilesystem(); const values: Entry[] = [];
  for await (const [name, handle] of (await directory(filename)).entries()) values.push({ name, isDirectory: () => handle.kind === 'directory', isFile: () => handle.kind === 'file', isSymbolicLink: () => false });
  return options?.withFileTypes ? values : values.map(value => value.name);
}
export async function lstat(filename: string) {
  await initializeFilesystem();
  try { await directory(filename); return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, size: 0 }; }
  catch (error) { if (!(error instanceof DOMException && error.name === 'TypeMismatchError') && (error as {code?:string}).code !== 'ENOENT') throw error; }
  const value = await (await file(filename)).getFile();
  return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: value.size };
}
export async function readFile(filename: string) { await initializeFilesystem(); try { return Buffer.from(await (await (await file(filename)).getFile()).arrayBuffer()); } catch (error) { return translate(error); } }
export async function open(filename: string, flags: string) {
  await initializeFilesystem();
  if (flags === 'wx') { try { await lstat(filename); throw ioError('EEXIST', '文件已经存在。'); } catch (error) { if ((error as {code?:string}).code !== 'ENOENT') throw error; } }
  await file(filename, true);
  return { writeFile: (value: string | Uint8Array) => rawWrite(filename, typeof value === 'string' ? Buffer.from(value) : value), sync: async () => {}, close: async () => {} };
}
export async function unlink(filename: string) { await initializeFilesystem(); try { await (await directory(path.dirname(filename))).removeEntry(path.basename(filename)); } catch (error) { translate(error); } }
export async function rm(filename: string, options: { recursive?: boolean; force?: boolean } = {}) {
  await initializeFilesystem(); mounted(filename);
  try { await (await directory(path.dirname(filename))).removeEntry(path.basename(filename), { recursive: options.recursive }); } catch (error) { if (options.force && error instanceof DOMException && error.name === 'NotFoundError') return; translate(error); }
}
export async function cp(source: string, destination: string, options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean } = {}) {
  if ((await lstat(source)).isDirectory()) {
    await mkdir(destination, { recursive: true });
    // 完成清单最后落盘，复制一半的目录不成为可信版本或导出包。
    const names = (await readdir(source)).sort((a,b) => Number(/^(manifest|PACKAGE)\.json$/.test(a)) - Number(/^(manifest|PACKAGE)\.json$/.test(b)));
    for (const name of names) await cp(path.join(source,name), path.join(destination,name), options);
  } else {
    if (options.errorOnExist) { try { await lstat(destination); throw ioError('EEXIST','目标文件已经存在。'); } catch (error) { if ((error as {code?:string}).code !== 'ENOENT') throw error; } }
    await rawWrite(destination, await readFile(source));
  }
}
export async function rename(source: string, destination: string) { await cp(source,destination,{recursive:true}); await rm(source,{recursive:true}); }
/** 旧版整理数据库只读迁移一次，原始 SQLite 文件保留在项目中。 */
export async function readLegacyWorkspace(filename: string): Promise<WorkspaceState> {
  const [{ default: init }, { default: wasmUrl }] = await Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')]);
  const SQL = await init({ locateFile: () => wasmUrl }), db = new SQL.Database(await readFile(filename));
  try { return { revision: Number(db.exec("SELECT value FROM metadata WHERE key='revision'")[0]?.values[0]?.[0] ?? 0), items: (db.exec('SELECT value FROM items ORDER BY rowid')[0]?.values ?? []).map(row => JSON.parse(String(row[0]))) }; }
  finally { db.close(); }
}
