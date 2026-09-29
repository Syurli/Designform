import { documentPresets } from '../server/document-presets.ts';
import { transientAssetUrls,isTransientProject } from '../shared/transient.ts';
import { createPresetProject } from '../server/creative/create-project.ts';
import { CreativeService } from '../server/creative/service.ts';
import { Buffer } from 'buffer';
import { detectMedia } from '../shared/creative/media.ts';
import { ProjectService } from '../server/projects.ts';
import { ProjectError } from '../server/files.ts';
import { initializeFilesystem,ensureExampleTemplate } from './platform.ts';
import type { CommitRequest, DocumentDraft, ProjectSnapshot } from '../shared/model.ts';
import { connectorRoute, connectorFetch, prepareConnectorSnapshot, latestConnectorSession, connectorSession, connectorAssetUrl } from './connector';

let service: ProjectService | undefined;
/** 所有正文操作均在本机执行；不向托管网站发送策划内容。 */
export async function browserApi(route: string, value?: unknown, temporary?: ProjectService): Promise<unknown> {
  const connected = !temporary && connectorRoute(route, value !== undefined);
  if (connected) { const response = await connectorFetch(connected, route, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); const result = await response.json(); if (!response.ok || result.error) throw Object.assign(new Error(result.error?.message ?? '本项目服务已断开。'), result.error); return prepareConnectorSnapshot(result); }
  // 接管后的页面不能再通过浏览器项目服务创建第二个文件写入者；示例临时服务不受影响。
  if (!temporary && latestConnectorSession()) throw new ProjectError('CONNECTOR_PROJECT_ONLY', '本机服务已接管此页面。请在另一个网页创建或打开其他项目；本项目协作继续运行。');
  if (!temporary) { await initializeFilesystem(); service ??= new ProjectService('/app/projects'); }
  const activeService = temporary ?? service!;
  const url = new URL(route, location.origin), input = (value ?? {}) as Record<string, unknown>;
  const str = (key: string) => { if (typeof input[key] !== 'string' || !input[key]) throw new ProjectError('INVALID_REQUEST', `${key}不能为空。`); return input[key] as string; };
  if (url.pathname === '/api/session' || url.pathname === '/api/projects' && value === undefined) return { ...await activeService.list(), token: '' };
  if (url.pathname === '/api/document-presets') { await activeService.list(); return documentPresets(activeService.home,value as never); }
  if (url.pathname === '/api/projects/save-as') return prepareSnapshot(await activeService.saveAs(input as never),activeService);
  if (url.pathname === '/api/creative-project') return prepareSnapshot(await createPresetProject(activeService,input), activeService);
  if (url.pathname === '/api/creative-capabilities') return new CreativeService(activeService).capabilities();
  if (url.pathname === '/api/connections') return { connections: [], heartbeatTimeoutMs: 35000 };
  if (url.pathname === '/api/integration') return { mode: 'web', launcher: '当前项目/.cewen/connector/runtime/策问MCP.cmd', guide: '当前项目/.cewen/connector/使用说明.md', deployment: '环境包就绪后，将当前项目 .cewen/connector/connector.zip 解压到同级 runtime 子目录，再运行 runtime/启动接入.cmd；MCP 入口为 runtime/策问MCP.cmd，无需手填 JSON。' };
  if (url.pathname === '/api/projects') {
    if (!['blank','basic','example'].includes(str('kind'))) throw new ProjectError('INVALID_TEMPLATE','请选择有效模板。');
    const directory = str('directory');
    if (input.kind !== 'example' && !directory.startsWith('/folders/')) throw new ProjectError('FOLDER_REQUIRED','请先选择本机的项目保存文件夹。');
    if (input.kind === 'example') await ensureExampleTemplate();
    return prepareSnapshot(await activeService.create(str('name'), input.kind as 'blank'|'basic'|'example', directory, input.setup as Parameters<ProjectService['create']>[3]), activeService);
  }
  if (url.pathname === '/api/projects/open') return prepareSnapshot(await activeService.read((await activeService.open(str('path'))).id), activeService);
  const match = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (!match) throw new ProjectError('NOT_FOUND','没有这个项目操作。');
  const [, id, operation] = match;
  const run = async (): Promise<unknown> => {
    switch (operation) {
      case undefined: return activeService.read(id,true,url.searchParams.get('verify') === '1');
      case 'creative': return new CreativeService(activeService).action(id,input);
      case 'upgrade-copy': return activeService.upgradeCopy(id,str('directory'));
      case 'history': return activeService.versions(id);
      case 'revision': return activeService.revision(id,url.searchParams.get('revision') ?? '');
      case 'workspace': return activeService.work(id,value as Parameters<ProjectService['work']>[1]);
      case 'commit': if (input.projectId !== id) throw new ProjectError('WRONG_PROJECT','提交与目标项目不匹配。'); return activeService.commit({ ...input, actor: input.restoredFrom ? 'restore' : 'user' } as unknown as CommitRequest);
      case 'recover': return activeService.recover(id,input.direction as 'continue'|'rollback');
      case 'drafts': return value === undefined ? activeService.drafts(id) : input.remove ? activeService.removeDraft(id,str('id')) : activeService.saveDraft(id,input as unknown as DocumentDraft);
      case 'restore-plan': return activeService.prepareRestore(id,str('revision'));
      case 'undo-plan': return activeService.prepareUndo(id,str('revision'));
      case 'baseline': return value === undefined ? activeService.baselines(id) : activeService.baseline(id,String(input.revision ?? ''),String(input.name ?? ''),input.baselineId as string|undefined,input.action as string|undefined);
      case 'checkpoint': return activeService.checkpoint(id,str('reason'),str('requestId'));
      case 'context': return activeService.context(id,input.documents as string[]|undefined,input);
      case 'paste-import': return activeService.pasteImport(id,str('text'),str('kind'));
      case 'review-import': return activeService.reviewImport(id,str('batch'),input.paths as string[],(input.edits ?? {}) as Record<string,string>);
      case 'import-plan': return activeService.importPlan(id,str('directory'));
      case 'apply-import': return activeService.applyImport(id,str('batch'));
      case 'questions': return activeService.publishQuestions(id,input as unknown as Parameters<ProjectService['publishQuestions']>[1]);
      case 'answers': return activeService.answer(id,input as unknown as Parameters<ProjectService['answer']>[1]);
      case 'proposals': return activeService.propose(id,input as unknown as Parameters<ProjectService['propose']>[1]);
      case 'accept-proposal': return activeService.acceptProposal(id,str('proposalId'),input.paths as string[],input.edits as Record<string,string>|undefined);
      case 'export': return activeService.exportProject(id,str('directory'),input.mode as 'current'|'history'|'full',input.includePersonal === true);
      case 'copy': return activeService.copyProject(id,str('name'),str('directory'));
      case 'delete': return activeService.deleteProject(id,str('path'),str('name'));
      case 'forget': return activeService.forget(id);
      case 'backup-status': return activeService.backupStatus(id);
      case 'reading-view': return activeService.readingView(id,value as Record<string,unknown>|undefined);
      case 'move-document': return activeService.moveDocument(id,str('documentId'),str('destination'));
      case 'reverse-relation': return activeService.reverseRelation(id,str('relationId'));
      case 'archive-documents': return activeService.archiveDocuments(id,input.documentIds as string[],input.archived === true);
      case 'begin-batch': return activeService.beginExternalBatch(id,str('requestId'));
      case 'end-batch': return activeService.endExternalBatch(id,str('batch'),str('reason'));
      default: throw new ProjectError('NOT_FOUND','没有这个项目操作。');
    }
  };
  const result = await run();
  if (result && typeof result === 'object' && 'project' in result && 'documents' in result && 'files' in result) return prepareSnapshot(result as ProjectSnapshot, activeService);
  return result;
}
const assetUrls = new Map<string, { hash: string; url: string }>();
export function browserAssetUrl(snapshot: ProjectSnapshot, filename: string) { if (connectorSession(snapshot.project.id)) return connectorAssetUrl(snapshot.project.id, filename, snapshot.historical ? snapshot.revision! : 'current'); return assetUrls.get(`${snapshot.project.id}:${snapshot.historical ? snapshot.revision : 'current'}:${filename}`)?.url ?? ''; }
/** 附件创建本机 Blob URL；哈希未变时复用，不通过 HTTP 上传或读取。 */
export async function prepareSnapshot(snapshot: ProjectSnapshot, activeService = service!) {
  if (connectorSession(snapshot.project.id)) return prepareConnectorSnapshot(snapshot);
  for (const [filename, hash] of Object.entries(snapshot.files ?? {})) {
    if (!filename.startsWith('docs/assets/')) continue;
    const key = `${snapshot.project.id}:${snapshot.historical ? snapshot.revision : 'current'}:${filename}`, cached = assetUrls.get(key);
    if (cached?.hash === hash) continue;
    const bytes = await activeService.asset(snapshot.project.id,filename,snapshot.historical ? snapshot.revision ?? undefined : undefined);
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? '', types: Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',csv:'text/csv',json:'application/json'};
    if (cached) URL.revokeObjectURL(cached.url);
    assetUrls.set(key,{hash,url:URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:types[extension] ?? 'application/octet-stream'}))});
    if(isTransientProject(snapshot.project.id))transientAssetUrls.set(snapshot.project.id+':'+filename,assetUrls.get(key)!.url);
  }
  return snapshot;
}

/** 新媒体延迟创建 Blob；同一不可变哈希在页面中只缓存一份。 */
export async function loadBrowserMedia(snapshot: ProjectSnapshot, filename: string) {
  const bridge = connectorSession(snapshot.project.id);
  if (bridge) { const response = await connectorFetch(bridge, `/api/projects/${snapshot.project.id}/asset?path=${encodeURIComponent(filename)}${snapshot.historical ? `&revision=${encodeURIComponent(snapshot.revision!)}` : ''}`); if (!response.ok) throw new ProjectError('ASSET_FAILED', '本项目附件读取失败。'); return URL.createObjectURL(await response.blob()); }
  await initializeFilesystem(); service ??= new ProjectService('/app/projects');
  const hash = snapshot.media?.[filename] ?? snapshot.files?.[filename];
  if (!hash) throw new ProjectError('MISSING_ASSET','附件不在当前快照的媒体清单中');
  const key = `${snapshot.project.id}:${snapshot.historical ? snapshot.revision : 'current'}:${filename}`;
  const cached = assetUrls.get(key); if (cached?.hash === hash) return cached.url;
  const bytes = await service.asset(snapshot.project.id,filename,snapshot.historical ? snapshot.revision ?? undefined : undefined), media = detectMedia(bytes);
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:media.mime})); assetUrls.set(key,{hash,url}); return url;
}
export async function uploadBrowserMedia(id: string, file: File, input: Record<string,unknown>) {
  const bridge = connectorSession(id);
  if (bridge) { const query = new URLSearchParams({requestId:String(input.requestId ?? ''),name:file.name,permission:String(input.permission ?? ''),durationMs:String(input.durationMs ?? 0)}); const response = await connectorFetch(bridge, `/api/projects/${id}/media-upload?${query}`, {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file}); const result = await response.json(); if(!response.ok||result.error)throw Object.assign(new Error(result.error?.message ?? '媒体上传失败。'),result.error); await prepareConnectorSnapshot(result.snapshot); return result; }
  await initializeFilesystem(); service ??= new ProjectService('/app/projects');
  const result = await new CreativeService(service).registerMedia(id,{...input,name:file.name},Buffer.from(await file.arrayBuffer()));
  await prepareSnapshot(result.snapshot); return result;
}

const mediaLeases = new Map<string,{url:string;bytes:number;refs:number;used:number}>();
const pendingMedia = new Map<string,Promise<{url:string;bytes:number;refs:number;used:number}>>();
const MEDIA_CACHE_LIMIT = 64*1024*1024;
function trimMediaCache(){let size=[...mediaLeases.values()].reduce((n,v)=>n+v.bytes,0);for(const [key,v] of [...mediaLeases].sort((a,b)=>a[1].used-b[1].used)){if(size<=MEDIA_CACHE_LIMIT)break;if(v.refs)continue;URL.revokeObjectURL(v.url);mediaLeases.delete(key);size-=v.bytes;}}
/** 同一不可变媒体在当前稿与历史间复用；有界缓存不撤销仍在播放的资源。 */
export async function acquireBrowserMedia(snapshot:ProjectSnapshot,filename:string){
 if(connectorSession(snapshot.project.id)){const url=await loadBrowserMedia(snapshot,filename);return {url,release:()=>URL.revokeObjectURL(url)};}
 await initializeFilesystem();service??=new ProjectService('/app/projects');
 const hash=snapshot.media?.[filename]??snapshot.files?.[filename];if(!hash)throw new ProjectError('MISSING_ASSET','媒体不在此修订的清单中');
 const key=`${snapshot.project.id}:${hash}`;let entry=mediaLeases.get(key);
 if(!entry){let pending=pendingMedia.get(key);if(!pending){pending=(async()=>{const bytes=await service!.asset(snapshot.project.id,filename,snapshot.historical?snapshot.revision??undefined:undefined),media=detectMedia(bytes);const value={url:URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:media.mime})),bytes:bytes.length,refs:0,used:Date.now()};mediaLeases.set(key,value);return value;})();pendingMedia.set(key,pending);pending.finally(()=>pendingMedia.delete(key)).catch(()=>{});}entry=await pending;}
 entry.refs++;entry.used=Date.now();trimMediaCache();let released=false;const held=entry;
 return {url:entry.url,release:()=>{if(released)return;released=true;held.refs=Math.max(0,held.refs-1);held.used=Date.now();trimMediaCache();}};
}
export function browserMediaCacheStatus(){return {entries:mediaLeases.size,bytes:[...mediaLeases.values()].reduce((n,v)=>n+v.bytes,0),leased:[...mediaLeases.values()].filter(v=>v.refs>0).length,limit:MEDIA_CACHE_LIMIT};}
