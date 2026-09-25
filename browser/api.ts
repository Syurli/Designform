import { createPresetProject } from '../server/creative/create-project.ts';
import { CreativeService } from '../server/creative/service.ts';
import { Buffer } from 'buffer';
import { detectMedia } from '../shared/creative/media.ts';
import { ProjectService } from '../server/projects.ts';
import { ProjectError } from '../server/files.ts';
import { initializeFilesystem,ensureExampleTemplate } from './platform.ts';
import type { CommitRequest, DocumentDraft, ProjectSnapshot } from '../shared/model.ts';

let service: ProjectService | undefined;
/** 所有正文操作均在本机执行；不向托管网站发送策划内容。 */
export async function browserApi(route: string, value?: unknown): Promise<unknown> {
  await initializeFilesystem(); service ??= new ProjectService('/app/projects');
  const url = new URL(route, location.origin), input = (value ?? {}) as Record<string, unknown>;
  const str = (key: string) => { if (typeof input[key] !== 'string' || !input[key]) throw new ProjectError('INVALID_REQUEST', `${key}不能为空。`); return input[key] as string; };
  if (url.pathname === '/api/session' || url.pathname === '/api/projects' && value === undefined) return { ...await service.list(), token: '' };
  if (url.pathname === '/api/creative-project') return prepareSnapshot(await createPresetProject(service,input));
  if (url.pathname === '/api/creative-capabilities') return new CreativeService(service).capabilities();
  if (url.pathname === '/api/connections') return { connections: [], heartbeatTimeoutMs: 35000 };
  if (url.pathname === '/api/integration') return { mode: 'web' };
  if (url.pathname === '/api/projects') {
    if (!['blank','basic','example'].includes(str('kind'))) throw new ProjectError('INVALID_TEMPLATE','请选择有效模板。');
    const directory = str('directory');
    if (input.kind !== 'example' && !directory.startsWith('/folders/')) throw new ProjectError('FOLDER_REQUIRED','请先选择本机的项目保存文件夹。');
    if (input.kind === 'example') await ensureExampleTemplate();
    return prepareSnapshot(await service.create(str('name'), input.kind as 'blank'|'basic'|'example', directory, input.setup as Parameters<ProjectService['create']>[3]));
  }
  if (url.pathname === '/api/projects/open') return prepareSnapshot(await service.read((await service.open(str('path'))).id));
  const match = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (!match) throw new ProjectError('NOT_FOUND','没有这个项目操作。');
  const [, id, operation] = match;
  const run = async (): Promise<unknown> => {
    switch (operation) {
      case undefined: return service!.read(id,true,url.searchParams.get('verify') === '1');
      case 'creative': return new CreativeService(service!).action(id,input);
      case 'upgrade-copy': return service!.upgradeCopy(id,str('directory'));
      case 'history': return service!.versions(id);
      case 'revision': return service!.revision(id,url.searchParams.get('revision') ?? '');
      case 'workspace': return service!.work(id,value as Parameters<ProjectService['work']>[1]);
      case 'commit': if (input.projectId !== id) throw new ProjectError('WRONG_PROJECT','提交与目标项目不匹配。'); return service!.commit({ ...input, actor: input.restoredFrom ? 'restore' : 'user' } as unknown as CommitRequest);
      case 'recover': return service!.recover(id,input.direction as 'continue'|'rollback');
      case 'drafts': return value === undefined ? service!.drafts(id) : input.remove ? service!.removeDraft(id,str('id')) : service!.saveDraft(id,input as unknown as DocumentDraft);
      case 'restore-plan': return service!.prepareRestore(id,str('revision'));
      case 'undo-plan': return service!.prepareUndo(id,str('revision'));
      case 'baseline': return value === undefined ? service!.baselines(id) : service!.baseline(id,String(input.revision ?? ''),String(input.name ?? ''),input.baselineId as string|undefined,input.action as string|undefined);
      case 'checkpoint': return service!.checkpoint(id,str('reason'),str('requestId'));
      case 'context': return service!.context(id,input.documents as string[]|undefined,input);
      case 'paste-import': return service!.pasteImport(id,str('text'),str('kind'));
      case 'review-import': return service!.reviewImport(id,str('batch'),input.paths as string[],(input.edits ?? {}) as Record<string,string>);
      case 'import-plan': return service!.importPlan(id,str('directory'));
      case 'apply-import': return service!.applyImport(id,str('batch'));
      case 'questions': return service!.publishQuestions(id,input as unknown as Parameters<ProjectService['publishQuestions']>[1]);
      case 'answers': return service!.answer(id,input as unknown as Parameters<ProjectService['answer']>[1]);
      case 'proposals': return service!.propose(id,input as unknown as Parameters<ProjectService['propose']>[1]);
      case 'accept-proposal': return service!.acceptProposal(id,str('proposalId'),input.paths as string[],input.edits as Record<string,string>|undefined);
      case 'export': return service!.exportProject(id,str('directory'),input.mode as 'current'|'history'|'full',input.includePersonal === true);
      case 'copy': return service!.copyProject(id,str('name'),str('directory'));
      case 'forget': return service!.forget(id);
      case 'backup-status': return service!.backupStatus(id);
      case 'reading-view': return service!.readingView(id,value as Record<string,unknown>|undefined);
      case 'move-document': return service!.moveDocument(id,str('documentId'),str('destination'));
      case 'reverse-relation': return service!.reverseRelation(id,str('relationId'));
      case 'archive-documents': return service!.archiveDocuments(id,input.documentIds as string[],input.archived === true);
      case 'begin-batch': return service!.beginExternalBatch(id,str('requestId'));
      case 'end-batch': return service!.endExternalBatch(id,str('batch'),str('reason'));
      default: throw new ProjectError('NOT_FOUND','没有这个项目操作。');
    }
  };
  const result = await run();
  if (result && typeof result === 'object' && 'project' in result && 'documents' in result && 'files' in result) return prepareSnapshot(result as ProjectSnapshot);
  return result;
}
const assetUrls = new Map<string, { hash: string; url: string }>();
export function browserAssetUrl(snapshot: ProjectSnapshot, filename: string) { return assetUrls.get(`${snapshot.project.id}:${snapshot.historical ? snapshot.revision : 'current'}:${filename}`)?.url ?? ''; }
/** 附件创建本机 Blob URL；哈希未变时复用，不通过 HTTP 上传或读取。 */
async function prepareSnapshot(snapshot: ProjectSnapshot) {
  for (const [filename, hash] of Object.entries(snapshot.files ?? {})) {
    if (!filename.startsWith('docs/assets/')) continue;
    const key = `${snapshot.project.id}:${snapshot.historical ? snapshot.revision : 'current'}:${filename}`, cached = assetUrls.get(key);
    if (cached?.hash === hash) continue;
    const bytes = await service!.asset(snapshot.project.id,filename,snapshot.historical ? snapshot.revision ?? undefined : undefined);
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? '', types: Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',csv:'text/csv',json:'application/json'};
    if (cached) URL.revokeObjectURL(cached.url);
    assetUrls.set(key,{hash,url:URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:types[extension] ?? 'application/octet-stream'}))});
  }
  return snapshot;
}

/** 新媒体延迟创建 Blob；同一不可变哈希在页面中只缓存一份。 */
export async function loadBrowserMedia(snapshot: ProjectSnapshot, filename: string) {
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
 await initializeFilesystem();service??=new ProjectService('/app/projects');
 const hash=snapshot.media?.[filename]??snapshot.files?.[filename];if(!hash)throw new ProjectError('MISSING_ASSET','媒体不在此修订的清单中');
 const key=`${snapshot.project.id}:${hash}`;let entry=mediaLeases.get(key);
 if(!entry){let pending=pendingMedia.get(key);if(!pending){pending=(async()=>{const bytes=await service!.asset(snapshot.project.id,filename,snapshot.historical?snapshot.revision??undefined:undefined),media=detectMedia(bytes);const value={url:URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:media.mime})),bytes:bytes.length,refs:0,used:Date.now()};mediaLeases.set(key,value);return value;})();pendingMedia.set(key,pending);pending.finally(()=>pendingMedia.delete(key)).catch(()=>{});}entry=await pending;}
 entry.refs++;entry.used=Date.now();trimMediaCache();let released=false;const held=entry;
 return {url:entry.url,release:()=>{if(released)return;released=true;held.refs=Math.max(0,held.refs-1);held.used=Date.now();trimMediaCache();}};
}
export function browserMediaCacheStatus(){return {entries:mediaLeases.size,bytes:[...mediaLeases.values()].reduce((n,v)=>n+v.bytes,0),leased:[...mediaLeases.values()].filter(v=>v.refs>0).length,limit:MEDIA_CACHE_LIMIT};}
