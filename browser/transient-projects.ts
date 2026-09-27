import { ProjectService } from '../server/projects';
import { CreativeService } from '../server/creative/service';
import { PresetService } from '../server/creative/preset-service';
import { Buffer } from 'buffer';
import { browserApi, prepareSnapshot } from './api';
import { memoryFiles } from './memory-files';
import { transientProjects,transientAssetUrls } from '../shared/transient';
import type { ProjectSnapshot } from '../shared/model';

const sessions = new Map<string, { service: ProjectService; root: string }>();
const urls = new Map<string, string>();
/** 临时示例与预设工作稿使用同一业务规则，所有文件操作落在独立内存树。 */
export async function createTransient(name: string, kind: 'example' | 'preset', preset = 'blank'): Promise<ProjectSnapshot> {
  const root = `/memory/session-${crypto.randomUUID()}`;
  memoryFiles.mkdir(root + '/templates', true); memoryFiles.mkdir(root + '/projects', true);
  const sources = import.meta.glob('../templates/example/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string,string>;
  for (const [filename, content] of Object.entries(sources)) memoryFiles.write(root + '/templates/' + filename.split('/templates/example/')[1], content);
  const service = new ProjectService(root + '/library', root + '/templates');
  let snapshot = await service.create(name, preset === 'basic' ? 'example' : 'blank', root + '/projects', { example: kind === 'example' });
  sessions.set(snapshot.project.id, { service, root }); transientProjects.set(snapshot.project.id, kind);
  if (kind === 'example' && !['blank','basic'].includes(preset)) snapshot = await new PresetService(service, new CreativeService(service)).apply(snapshot.project.id, { requestId: crypto.randomUUID(), instanceId: 'demo-' + crypto.randomUUID().slice(0,8), preset, sample: true });
  return prepareSnapshot(snapshot, service);
}
export async function transientApi(route: string, input?: unknown) {
  const match = /\/api\/projects\/([A-Za-z0-9_-]+)/.exec(route), session = match && sessions.get(match[1]);
  if (!session) throw new Error('临时会话已经结束。');
  if (/\/(export|copy|upgrade-copy|forget|delete)$/.test(route)) throw new Error('请先将临时内容另存为正式项目。');
  const action=(input as {action?:string})?.action;
  if(action&&(/export|bundle|wanlei|comfy/.test(action)||action.startsWith('production-')&&!['production-read','production-jobs'].includes(action)))throw new Error('请先通过“项目另存为”建立正式项目，再执行导出或素材生产。');
  return browserApi(route, input, session.service);
}
export async function transientMedia(snapshot: ProjectSnapshot, filename: string) {
  const key = `${snapshot.project.id}:${filename}:${snapshot.media?.[filename] ?? snapshot.files?.[filename]}`;
  if (urls.has(key)) return urls.get(key)!;
  const bytes = await sessions.get(snapshot.project.id)!.service.asset(snapshot.project.id, filename);
  const extension = filename.split('.').at(-1)?.toLowerCase() ?? '';
  const mime: Record<string,string> = { png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4' };
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime[extension] ?? 'application/octet-stream' })); urls.set(key,url); return url;
}
export async function transientUpload(id: string, file: File, input: Record<string,unknown>) { return new CreativeService(sessions.get(id)!.service).registerMedia(id, {...input,name:file.name,originalName:file.name}, Buffer.from(await file.arrayBuffer())); }
/** 另存为只导出公开当前稿，凭证、缓存、版本和恢复日志均不复制。 */
export async function transientContent(id: string) {
  const session = sessions.get(id)!; const snapshot = await session.service.read(id);
  const files: Record<string,string> = {};
  for (const filename of [...Object.keys(snapshot.files ?? {}), ...Object.keys(snapshot.media ?? {})]) files[filename] = memoryFiles.read(snapshot.project.path + '/' + filename).toString('base64');
  return { snapshot, files, workspaceItems:(await session.service.work(id)).items };
}
export function disposeTransient(id: string) {
  const session = sessions.get(id); if (!session) return;
  session.service.close(); memoryFiles.remove(session.root, true); sessions.delete(id); transientProjects.delete(id);
  for (const [key,url] of urls) if (key.startsWith(id+':')) { URL.revokeObjectURL(url); urls.delete(key); }
  for(const [key,url] of transientAssetUrls)if(key.startsWith(id+':')){URL.revokeObjectURL(url);transientAssetUrls.delete(key);}
}
