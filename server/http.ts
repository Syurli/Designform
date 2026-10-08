import { documentPresets } from './document-presets.ts';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type CommitRequest, type DocumentDraft, type WorkspaceItem } from '../shared/model.ts';
import { ProjectError } from './files.ts';
import { ProjectService } from './projects.ts';
import { createPresetProject } from './creative/create-project.ts';
import { ComfyConnector } from './creative/comfy.ts';
import { CreativeService } from './creative/service.ts';
import { detectMedia, MEDIA_LIMIT } from '../shared/creative/media.ts';
import { ConnectionRegistry } from './connections.ts';
import { chooseNativeDirectory } from './native-dialog.ts';
import { installedFonts } from './system-fonts.ts';
import { CollaborationService } from './collaboration.ts';
import type { ProjectSnapshot } from '../shared/model.ts';
import { createConnectionDiagnostics, type ConnectionTiming } from './connection-diagnostics.ts';

/** API 生命周期由本地宿主管理；开发、浏览器和桌面复用同一服务实现。 */
export function createProjectApi(options: { home?: string; templateRoot?: string; root?: string; chooseDirectory?: (initial: string) => Promise<string | null>; installation?: string; sessionToken?: string; projectId?: string } = {}) {
  const service = new ProjectService(options.home ?? process.env.CEWEN_HOME ?? path.join(os.homedir(), 'Documents', '策问工作区', '开发沙盒'), options.templateRoot);
  const creative = new CreativeService(service);
  const token = options.sessionToken ?? randomBytes(32).toString('hex');
  const connections = new ConnectionRegistry();
  const recordConnection = createConnectionDiagnostics(service.home);
  const collaboration = new CollaborationService(service, id => connections.read().connections.some(connection => connection.id === id && connection.status === 'connected'));

  /** 有界请求体避免错误客户端把整个资料库塞入一个正文提交。 */
  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > (request.url === '/api/projects/save-as'||/\/commit$/.test(request.url??'') ? 256 : request.url==='/api/document-presets'?32:8) * 1024 * 1024) throw new ProjectError('REQUEST_TOO_LARGE', '本次提交内容过大，请分批处理。');
      chunks.push(bytes);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new ProjectError('INVALID_JSON', '请求内容不是有效 JSON 对象。'); }
  }
  function sendRaw(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  }
  /** 所有当前快照携带同一份服务端任务锁，避免个别保存入口返回可编辑的旧状态。 */
  function send(response: ServerResponse, value: unknown, status = 200) {
    const candidate = value as { project?: unknown; documents?: unknown; snapshot?: ProjectSnapshot } | null;
    const snapshot = candidate?.project && Array.isArray(candidate.documents) ? value as ProjectSnapshot : candidate?.snapshot;
    if (!snapshot) { sendRaw(response, value, status); return; }
    void collaboration.decorate(snapshot).then(() => sendRaw(response, value, status)).catch(error => sendRaw(response, { error: { code: 'WORK_STATE_ERROR', message: error instanceof Error ? error.message : String(error) } }, 409));
  }
  const required = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new ProjectError('INVALID_REQUEST', `${name}不能为空。`);
    return value;
  };

  /** 回环地址、同源与会话凭证一起约束本地写入，正文不能成为执行命令。 */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!request.url?.startsWith('/api/')) return false;
    const started = performance.now(), stages: Record<string, number> = {};
    const diagnosticRoute = request.url.split('?')[0];
    let errorCode: string | undefined, mode: ConnectionTiming['mode'];
    if (['/api/session', '/api/projects', '/api/connections'].includes(diagnosticRoute)) {
      const record = (status: number) => {
        const elapsedMs = Math.round(performance.now() - started);
        // 高频轻量心跳只记录慢请求和失败；握手、列表保留完整阶段便于核对。
        if (diagnosticRoute === '/api/connections' && status >= 200 && status < 400 && elapsedMs < 1000) return;
        recordConnection({ at: new Date().toISOString(), route: diagnosticRoute as ConnectionTiming['route'], method: request.method ?? '', ...(mode ? { mode } : {}), status, elapsedMs, ...(errorCode ? { errorCode } : {}), stages: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, Math.round(value)])) });
      };
      response.once('finish', () => record(response.statusCode));
      response.once('close', () => { if (!response.writableFinished) record(0); });
    }
    /** 时序头只带数字阶段，不包含请求参数，诊断写入不在响应关键路径。 */
    const sendTiming = () => response.setHeader('Server-Timing', Object.entries({ ...stages, responseMs: performance.now() - started }).map(([name, value]) => `${name};dur=${value.toFixed(1)}`).join(', '));
    try {
      const authority = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(authority)) throw new ProjectError('HOST_DENIED', '本地服务只接受回环地址访问。');
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${authority}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new ProjectError('ORIGIN_DENIED', '请求来源与本地工作台不一致。');
      const url = new URL(request.url, `http://${authority}`);
      // 短号只在入口解析，配对范围检查继续使用正式项目身份。
      const projectRef = /^\/api\/projects\/(P[a-z0-9]{1,7})(?=\/|$)/.exec(url.pathname);
      if (projectRef) {
        if(request.headers['x-cewen-session']!==token)throw new ProjectError('SESSION_REQUIRED','连接已更新，请重新连接本地工作台。');
        url.pathname = url.pathname.replace('/' + projectRef[1], '/' + await service.resolveProjectRef(projectRef[1]));
      }
      // 独立连接器仅服务启动器核实过的一个项目；原生 MCP 端口也不能越过此边界。
      if (options.projectId) {
        const scoped = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(url.pathname);
        const globalRead = request.method === 'GET' && ['/api/session','/api/projects','/api/integration','/api/connections','/api/creative-capabilities','/api/fonts','/api/document-presets'].includes(url.pathname);
        const heartbeat = url.pathname === '/api/connections' && request.method === 'POST';
        if (!globalRead && !heartbeat && (!scoped || scoped[1] !== options.projectId || ['copy','delete','forget','export','import-plan','upgrade-copy'].includes(scoped[2]))) throw new ProjectError('PROJECT_SCOPE_DENIED', '此连接器仅允许访问已配对项目。');
      }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        response.setHeader('Set-Cookie', `cewen=${token}; HttpOnly; SameSite=Strict; Path=/api/`);
        // 凭证签发独立于项目初始化、项目库队列和历史磁盘读取。
        if (url.searchParams.get('handshake') === '1') { mode = 'handshake'; sendTiming(); send(response, { protocolVersion: PROTOCOL_VERSION, token }); return true; }
        mode = 'library';
        const listed = await service.list(timing => Object.assign(stages, timing));
        sendTiming();
        send(response, { protocolVersion: PROTOCOL_VERSION, token, ...listed, ...(options.projectId ? { projects: listed.projects.filter(project => project.id === options.projectId) } : {}) }); return true;
      }
      const imageRead = request.method === 'GET' && /\/asset$/.test(url.pathname) && request.headers.cookie?.split(';').some(cookie => cookie.trim() === `cewen=${token}`);
      if (request.headers['x-cewen-session'] !== token && !imageRead) throw new ProjectError('SESSION_REQUIRED', '连接已更新，请重新连接本地工作台。');
      // 字体目录属于本机只读能力，与项目正文和字体文件内容隔离。
      if (url.pathname === '/api/fonts' && request.method === 'GET') { send(response, await installedFonts(url.searchParams.get('refresh') === '1')); return true; }
      if (url.pathname === '/api/choose-directory' && request.method === 'POST') {
        const input = await body(request); send(response, { path: await (options.chooseDirectory ?? chooseNativeDirectory)(typeof input.initial === 'string' ? input.initial : '') }); return true;
      }
      if (url.pathname === '/api/integration' && request.method === 'GET') {
        const root = options.root ?? path.resolve('.');
        send(response, { mode: 'local', root, skill: path.join(root,'integration/skills/cewen-collaborate/SKILL.md'), guide: path.join(root,options.installation?'integration/protocol/INTEGRATION.md':'docs/protocol/INTEGRATION.md'), launcher: options.installation ? path.join(options.installation,'策问MCP.cmd') : '', runtime: path.join(root,'runtime/mcp.js'), url: `http://${authority}` }); return true;
      }
      if(url.pathname==='/api/creative-project'&&request.method==='POST'){send(response,await createPresetProject(service,await body(request)));return true;}
      if (url.pathname === '/api/creative-capabilities' && request.method === 'GET') { send(response, creative.capabilities()); return true; }
      if (url.pathname === '/api/connections' && request.method === 'GET') { send(response, connections.read()); return true; }
      if (url.pathname === '/api/connections' && request.method === 'POST') { const bodyStarted = performance.now(), input = await body(request); stages.bodyMs = performance.now() - bodyStarted; const updateStarted = performance.now(), state = connections.update(input); stages.registryMs = performance.now() - updateStarted; sendTiming(); send(response, state); return true; }
      if (url.pathname === '/api/document-presets') { await service.list(); send(response, await documentPresets(service.home, request.method === 'POST' ? await body(request) : undefined)); return true; }
      if (url.pathname === '/api/projects/save-as' && request.method === 'POST') { send(response,await service.saveAs(await body(request) as never));return true; }
      if (url.pathname === '/api/projects' && request.method === 'GET') { mode = 'library'; const listed = await service.list(timing => Object.assign(stages, timing)); sendTiming(); send(response, { ...listed, ...(options.projectId ? { projects: listed.projects.filter(project => project.id === options.projectId) } : {}) }); return true; }
      if (url.pathname === '/api/projects' && request.method === 'POST') {
        const input = await body(request);
        if (!['blank', 'basic', 'example'].includes(String(input.kind))) throw new ProjectError('INVALID_TEMPLATE', '请选择空白、基础总纲或虚构示例。');
        send(response, await service.create(required(input.name, '项目名称'), input.kind as 'blank' | 'basic' | 'example', typeof input.directory === 'string' && input.directory ? input.directory : undefined, input.setup as Parameters<ProjectService['create']>[3])); return true;
      }
      if (url.pathname === '/api/projects/open' && request.method === 'POST') { const input = await body(request); const project = await service.open(required(input.path, '项目目录')); send(response, await service.read(project.id)); return true; }
      const workMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/work-(begin|documents|write|finish|status|control|events)$/.exec(url.pathname);
      if (workMatch) {
        const [, id, operation] = workMatch;
        if (operation === 'status' && request.method === 'GET') { send(response, await collaboration.status(id, url.searchParams.get('taskId') ?? undefined, url.searchParams.get('includeDrafts') === '1')); return true; }
        if (operation === 'events' && request.method === 'GET') {
          await service.collaborationRoot(id);
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.flushHeaders();
          const unsubscribe = collaboration.subscribe(id, Number(url.searchParams.get('cursor') ?? 0), event => response.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`));
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000); heartbeat.unref();
          response.once('close', () => { clearInterval(heartbeat); unsubscribe(); }); return true;
        }
        if (request.method === 'POST' && !['status','events'].includes(operation)) {
          const input = await body(request), connectionId = operation === 'control' && input.connectionId === undefined ? undefined : required(input.connectionId, '协作连接身份');
          if (operation === 'begin') send(response, await collaboration.begin(id, connectionId!, input as never));
          if (operation === 'documents') send(response, await collaboration.documents(id, connectionId!, input as never));
          if (operation === 'write') send(response, await collaboration.write(id, connectionId!, input as never));
          if (operation === 'finish') send(response, await collaboration.finish(id, connectionId!, input as never));
          if (operation === 'control') send(response, await collaboration.control(id, connectionId, input as never));
          return true;
        }
      }
      const creativeMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/(creative|media-upload|upgrade-copy|comfy)$/.exec(url.pathname);
      if (creativeMatch && request.method === 'POST') {
        const [, id, operation] = creativeMatch;
        if (operation === 'comfy') { send(response,await new ComfyConnector(service).action(id,await body(request))); return true; }
        if (operation === 'media-upload') {
          // 二进制上传与正文 JSON 分离；有界读取，绝不将客户端路径当作磁盘路径。
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > MEDIA_LIMIT) throw new ProjectError('MEDIA_TOO_LARGE','单个媒体文件超过 64 MiB'); chunks.push(bytes); }
          send(response, await creative.registerMedia(id, { requestId: required(url.searchParams.get('requestId'),'请求 ID'), name: url.searchParams.get('name') ?? 'media', permission: url.searchParams.get('permission') ?? '', durationMs: Number(url.searchParams.get('durationMs') ?? 0) }, Buffer.concat(chunks)));
        } else { const input = await body(request); send(response, operation === 'upgrade-copy' ? await service.upgradeCopy(id, required(input.directory,'独立副本父目录')) : await creative.action(id, input)); }
        return true;
      }
      const match = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(commit|history|recover|drafts|revision|restore-plan|baseline|workspace|asset|import-plan|apply-import|context|questions|answers|proposals|accept-proposal|export|copy|forget|delete|checkpoint|undo-plan|move-document|paste-import|review-import|backup-status|reading-view|begin-batch|end-batch|reverse-relation|archive-documents|collaboration-status|collaboration-document|proposal-status|collaboration-asset))?$/.exec(url.pathname);
      if (match) {
        const [, id, operation] = match;
        if (!operation && request.method === 'GET') { send(response, await service.read(id, true, url.searchParams.get('verify') === '1')); return true; }
        if (operation === 'collaboration-status' && request.method === 'GET') { send(response, await service.collaborationStatus(id)); return true; }
        if (operation === 'collaboration-document' && request.method === 'POST') { const input = await body(request); send(response, await service.collaborationDocument(id, required(input.documentId, '文档身份'), Number(input.offset ?? 0), Number(input.limit ?? 50000))); return true; }
        if (operation === 'proposal-status' && request.method === 'POST') { const input = await body(request); send(response, await service.proposalStatus(id, typeof input.proposalId === 'string' && input.proposalId ? input.proposalId : undefined)); return true; }
        if (operation === 'collaboration-asset' && request.method === 'POST') { const input = await body(request); send(response, await service.collaborationAsset(id, required(input.path, '附件路径'), typeof input.revision === 'string' && input.revision ? input.revision : undefined)); return true; }
        if (operation === 'paste-import' && request.method === 'POST') { const input = await body(request); send(response, await service.pasteImport(id, required(input.text, '粘贴内容'), String(input.kind))); return true; }
        if (operation === 'review-import' && request.method === 'POST') { const input = await body(request); if (!Array.isArray(input.paths)) throw new ProjectError('INVALID_SELECTION', '请选择导入文件。'); send(response, await service.reviewImport(id, required(input.batch, '批次'), input.paths as string[], (input.edits ?? {}) as Record<string,string>)); return true; }
        if (operation === 'undo-plan' && request.method === 'POST') { const input = await body(request); send(response, await service.prepareUndo(id, required(input.revision, '版本'))); return true; }
        if (operation === 'move-document' && request.method === 'POST') { const input = await body(request); send(response, await service.moveDocument(id, required(input.documentId, '文档'), required(input.destination, '新路径'))); return true; }
        if (operation === 'begin-batch' && request.method === 'POST') { const input = await body(request); send(response, await service.beginExternalBatch(id, required(input.requestId, '请求身份'))); return true; }
        if (operation === 'end-batch' && request.method === 'POST') { const input = await body(request); send(response, await service.endExternalBatch(id, required(input.batch, '批次身份'), required(input.reason, '说明'))); return true; }
        if (operation === 'reverse-relation' && request.method === 'POST') { const input = await body(request); send(response, await service.reverseRelation(id, required(input.relationId, '关系身份'))); return true; }
        if (operation === 'archive-documents' && request.method === 'POST') { const input = await body(request); if (!Array.isArray(input.documentIds)) throw new ProjectError('INVALID_SELECTION', '需要文档身份列表。'); send(response, await service.archiveDocuments(id, input.documentIds as string[], input.archived === true)); return true; }
        if (operation === 'reading-view') { send(response, await service.readingView(id, request.method === 'POST' ? await body(request) : undefined)); return true; }
        if (operation === 'backup-status' && request.method === 'GET') { send(response, await service.backupStatus(id)); return true; }
        if (operation === 'baseline' && request.method === 'GET') { send(response, await service.baselines(id)); return true; }
        if (operation === 'checkpoint' && request.method === 'POST') { const input = await body(request); send(response, await service.checkpoint(id, required(input.reason, '本轮说明'), required(input.requestId, '请求 ID'))); return true; }
        if (operation === 'context' && request.method === 'POST') { const input = await body(request); for (const key of ['documents','nodeIds','collectionIds','annotationIds']) if (input[key] !== undefined && (!Array.isArray(input[key]) || (input[key] as unknown[]).some(value => typeof value !== 'string'))) throw new ProjectError('INVALID_REQUEST', '上下文范围需要字符串 ID 列表。'); send(response, await service.context(id, input.documents as string[] | undefined, input as { nodeIds?: string[]; collectionIds?: string[]; annotationIds?: string[] })); return true; }
        if (operation === 'import-plan' && request.method === 'POST') { const input = await body(request); send(response, await service.importPlan(id, required(input.directory, '来源目录'))); return true; }
        if (operation === 'apply-import' && request.method === 'POST') { const input = await body(request); send(response, await service.applyImport(id, required(input.batch, '导入批次'))); return true; }
        if (operation === 'questions' && request.method === 'POST') { const input = await body(request); send(response, await service.publishQuestions(id, input as unknown as Parameters<ProjectService['publishQuestions']>[1])); return true; }
        if (operation === 'answers' && request.method === 'POST') { const input = await body(request); send(response, await service.answer(id, input as unknown as Parameters<ProjectService['answer']>[1])); return true; }
        if (operation === 'proposals' && request.method === 'POST') { const input = await body(request); send(response, await service.propose(id, input as unknown as Parameters<ProjectService['propose']>[1])); return true; }
        if (operation === 'accept-proposal' && request.method === 'POST') { const input = await body(request); if (!Array.isArray(input.paths) || input.paths.some(name => typeof name !== 'string')) throw new ProjectError('INVALID_SELECTION', '请选择需要采纳的文件。'); send(response, await service.acceptProposal(id, required(input.proposalId, '提案'), input.paths as string[], input.edits as Record<string, string> | undefined)); return true; }
        if (operation === 'export' && request.method === 'POST') { const input = await body(request); if (!['current','history','full'].includes(String(input.mode))) throw new ProjectError('INVALID_EXPORT', '请选择导出内容。'); send(response, await service.exportProject(id, required(input.directory, '输出父目录'), input.mode as 'current' | 'history' | 'full', input.includePersonal === true)); return true; }
        if (operation === 'copy' && request.method === 'POST') { const input = await body(request); send(response, await service.copyProject(id, required(input.name, '新项目名称'), required(input.directory, '保存父目录'))); return true; }
        if (operation === 'delete' && request.method === 'POST') { const input=await body(request); send(response,await service.deleteProject(id,required(input.path,'确认路径'),required(input.name,'确认名称')));return true; }
        if (operation === 'forget' && request.method === 'POST') { send(response, await service.forget(id)); return true; }
        if (operation === 'history' && request.method === 'GET') { send(response, await service.versions(id)); return true; }
        if (operation === 'revision' && request.method === 'GET') { send(response, await service.revision(id, required(url.searchParams.get('revision'), '版本'))); return true; }
        if (operation === 'workspace' && request.method === 'GET') { send(response, await service.work(id)); return true; }
        if (operation === 'workspace' && request.method === 'POST') { const input = await body(request); send(response, await service.work(id, input as unknown as { baseRevision: number; item?: WorkspaceItem; remove?: string })); return true; }
        if (operation === 'restore-plan' && request.method === 'POST') { const input = await body(request); send(response, await service.prepareRestore(id, required(input.revision, '版本'))); return true; }
        if (operation === 'baseline' && request.method === 'POST') { const input = await body(request); send(response, await service.baseline(id, required(input.revision, '版本'), required(input.name, '基线名称'), input.baselineId as string | undefined, input.action as string | undefined)); return true; }
        if (operation === 'asset' && request.method === 'GET') {
          const relative = required(url.searchParams.get('path'), '附件路径'), bytes = await service.asset(id, relative, url.searchParams.get('revision') ?? undefined);
          const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
          response.writeHead(200, { 'Content-Type': types[path.extname(relative).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...(types[path.extname(relative).toLowerCase()] ? {} : { 'Content-Disposition': 'attachment' }) }); response.end(bytes); return true;
        }
        if (operation === 'drafts' && request.method === 'GET') { send(response, await service.drafts(id)); return true; }
        if (operation === 'drafts' && request.method === 'POST') {
          const input = await body(request);
          if (input.remove === true) { await service.removeDraft(id, required(input.id, '草稿身份')); send(response, { saved: true }); }
          else send(response, await service.saveDraft(id, input as unknown as DocumentDraft));
          return true;
        }
        if (operation === 'commit' && request.method === 'POST') {
          const input = await body(request);
          if (input.projectId !== id) throw new ProjectError('WRONG_PROJECT', '提交与目标项目身份不一致。');
          if (!Array.isArray(input.changes) || input.changes.some(change => !change || typeof change !== 'object' || typeof change.path !== 'string' || (change.baseHash !== null && typeof change.baseHash !== 'string'))) throw new ProjectError('INVALID_REQUEST', '文件修改清单不正确。');
          // 浏览器手工保存只允许 user 来源；模型提案会使用独立审核入口。
          send(response, await service.commit({ ...input, actor: input.restoredFrom ? 'restore' : 'user' } as unknown as CommitRequest)); return true;
        }
        if (operation === 'recover' && request.method === 'POST') {
          const input = await body(request);
          if (input.direction !== 'continue' && input.direction !== 'rollback') throw new ProjectError('INVALID_REQUEST', '请选择继续完成或撤回未完成批次。');
          send(response, await service.recover(id, input.direction)); return true;
        }
      }
      send(response, { error: { code: 'NOT_FOUND', message: '没有这个项目操作。' } }, 404);
    } catch (error) {
      const failure = error instanceof ProjectError ? error : new ProjectError('LOCAL_IO_ERROR', error instanceof Error ? error.message : '本地文件操作未完成。');
      errorCode = failure.code;
      send(response, { error: { code: failure.code, message: failure.message, details: failure.details } }, failure.code.includes('CONFLICT') || failure.code === 'RECOVERY_REQUIRED' ? 409 : failure.code.endsWith('DENIED') || failure.code === 'SESSION_REQUIRED' ? 403 : 400);
    }
    return true;
  }
  return { service, creative, collaboration, handle };
}
