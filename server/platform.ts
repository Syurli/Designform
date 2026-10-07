import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceState, WorkspaceItem } from '../shared/model.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';

/** 删除操作由上层确认精确项目根目录；Windows 移入回收站，失败不降级为永久删除。 */
export async function recycleDirectory(directory: string) {
  if(process.platform!=='win32')throw new Error('当前平台未提供回收站，请在系统文件管理器中删除此项目。');
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CEWEN_RECYCLE_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)`;
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',globalThis.Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,CEWEN_RECYCLE_TARGET:directory}});
}

/** 桌面文件能力集中在边界模块；网页构建替换此模块，业务规则与版本格式继续共用。 */
export { cp, mkdir, readdir, realpath, rm, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
export { watch, type FSWatcher } from 'node:fs';
export { default as path } from 'node:path';
export { createHash, randomUUID } from 'node:crypto';
export { Buffer } from 'node:buffer';
export const defaultTemplateRoot = fileURLToPath(new URL('../templates/example/', import.meta.url));
export const runtimeKind: 'desktop' | 'web' = 'desktop';
export const backupStateFile = '.cewen/backup-state.json';
export const runtimePid = process.pid;
/** 进程号只在本机有意义；锁同时登记主机，避免跨电脑复制后误认同号进程。 */
export const runtimeHost: string | undefined = hostname().toLowerCase();
export function ownerAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
export async function runtimeLock<T>(_root: string, action: () => Promise<T>): Promise<T> { return action(); }

/** 升级只读取旧整理数据库，原文件保留；从此两端共同使用可恢复的 JSON 工作记录。 */
export async function readLegacyWorkspace(filename: string): Promise<WorkspaceState> {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return { revision: Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value ?? 0), items: db.prepare('SELECT value FROM items ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as WorkspaceItem) }; }
  finally { db.close(); }
}
