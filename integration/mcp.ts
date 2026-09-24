import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalClient } from './client.ts';
import type { ProjectSnapshot } from '../shared/model.ts';
import { createPresence } from './presence.ts';

/** 本地 stdio 适配器只使用公开服务；输出通道仅用于 MCP，日志走标准错误。 */
const server = new McpServer({ name: 'baige-cewen', version: '0.7.1' }), local = new LocalClient();
const presence = createPresence(server);
/** 记录访问的项目和时间，不把工具参数或文档正文泄露到连接面板。 */
const client = { request<T = unknown>(route: string, input?: unknown) { presence.activity(route); return local.request<T>(route, input); } };
const project = z.string().regex(/^[A-Za-z0-9_-]+$/);
const idList = z.array(z.string().min(1)).max(200).default([]);
const result = async (action: () => Promise<unknown>) => { try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; } };

server.registerTool('cewen_identify', { description: '报告本次会话明确已知的模型名称，仅更新连接显示；无法确认时传空字符串，不猜测厂商或型号。不会读取或修改项目文档。', inputSchema: { modelName: z.string().max(120) } }, ({ modelName }) => result(() => presence.identify(modelName)));
server.registerTool('cewen_projects', { description: '列出已明确打开的策问项目，不扫描其他目录。', annotations: { readOnlyHint: true } }, () => result(() => client.request('/api/projects')));

server.registerTool('cewen_status', { description: '读取当前项目协作状态：公开修订、项目入口及哈希、文件哈希、诊断、恢复标记和内容数量。开始修改前优先调用；不返回私人工作区。', inputSchema: { projectId: project }, annotations: { readOnlyHint: true } }, ({ projectId }) => result(() => client.request(`/api/projects/${projectId}/collaboration-status`)));
server.registerTool('cewen_context', { description: '读取选定公开 Markdown、修订、关系、公开伴随文件与显式选择的项目级批注，同时返回当前诊断、恢复状态、指纹和文件哈希。空范围读取全部公开文档；超限请缩小范围。', inputSchema: { projectId: project, documentIds: idList, nodeIds: idList, collectionIds: idList, annotationIds: idList }, annotations: { readOnlyHint: true } }, ({ projectId, documentIds, nodeIds, collectionIds, annotationIds }) => result(() => client.request(`/api/projects/${projectId}/context`, { documents: documentIds, nodeIds, collectionIds, annotationIds })));
server.registerTool('cewen_read_document', { description: '按字符窗口读取一份当前公开文档，适合大文档和精确续读；同时返回当前诊断和恢复状态。', inputSchema: { projectId: project, documentId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100000).default(50000) }, annotations: { readOnlyHint: true } }, ({ projectId, documentId, offset, limit }) => result(() => client.request(`/api/projects/${projectId}/collaboration-document`, { documentId, offset, limit })));
server.registerTool('cewen_search', { description: '按标题、正文或身份搜索，返回可继续读取的文档身份。', inputSchema: { projectId: project, query: z.string().min(1), offset: z.number().int().min(0).default(0) }, annotations: { readOnlyHint: true } }, ({ projectId, query, offset }) => result(async () => { const snapshot = await client.request<ProjectSnapshot>(`/api/projects/${projectId}`), lower = query.toLowerCase(), matches = snapshot.documents.filter(document => `${document.id} ${document.title} ${document.text}`.toLowerCase().includes(lower)); return { revision: snapshot.revision, recoveryRequired: snapshot.recoveryRequired, diagnostics: snapshot.diagnostics, total: matches.length, offset, documents: matches.slice(offset, offset + 25).map(({ id, path, title, hash }) => ({ id, path, title, hash })) }; }));

server.registerTool('cewen_history', { description: '列出公开版本及校验状态。', inputSchema: { projectId: project }, annotations: { readOnlyHint: true } }, ({ projectId }) => result(() => client.request(`/api/projects/${projectId}/history`)));
server.registerTool('cewen_read_revision', { description: '读取完整历史快照，不修改当前稿。', inputSchema: { projectId: project, revision: z.string().min(1) }, annotations: { readOnlyHint: true } }, ({ projectId, revision }) => result(() => client.request(`/api/projects/${projectId}/revision?revision=${encodeURIComponent(revision)}`)));
server.registerTool('cewen_baselines', { description: '读取项目命名基线。', inputSchema: { projectId: project }, annotations: { readOnlyHint: true } }, ({ projectId }) => result(() => client.request(`/api/projects/${projectId}/baseline`)));
server.registerTool('cewen_backup_status', { description: '读取项目自动恢复点状态与最近备份错误，不创建或删除备份。', inputSchema: { projectId: project }, annotations: { readOnlyHint: true } }, ({ projectId }) => result(() => client.request(`/api/projects/${projectId}/backup-status`)));
server.registerTool('cewen_prepare_restore', { description: '为指定历史修订生成可审核的恢复计划，不执行恢复。用户仍需在策问决定是否应用。', inputSchema: { projectId: project, revision: z.string().min(1) }, annotations: { readOnlyHint: true } }, ({ projectId, revision }) => result(() => client.request(`/api/projects/${projectId}/restore-plan`, { revision })));
server.registerTool('cewen_prepare_undo', { description: '为指定历史批次生成可审核的反向差异计划，不执行撤销。', inputSchema: { projectId: project, revision: z.string().min(1) }, annotations: { readOnlyHint: true } }, ({ projectId, revision }) => result(() => client.request(`/api/projects/${projectId}/undo-plan`, { revision })));

server.registerTool('cewen_proposals', { description: '列出项目级提案或读取指定提案的状态、候选内容与逐文件采纳结果；不返回私人工作项。', inputSchema: { projectId: project, proposalId: z.string().optional() }, annotations: { readOnlyHint: true } }, ({ projectId, proposalId }) => result(() => client.request(`/api/projects/${projectId}/proposal-status`, { proposalId: proposalId ?? '' })));
server.registerTool('cewen_asset', { description: '读取项目 docs/assets 下明确指定的 PNG/JPEG/WebP/GIF 图片，供图文策划任务实际查看。单张上限 5 MB；不读取任意磁盘路径或私人文件。', inputSchema: { projectId: project, path: z.string().min(1), revision: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ projectId, path, revision }) => {
  try {
    const asset = await client.request<{ path: string; revision: string | null; mimeType: string; bytes: number; hash: string; data: string }>(`/api/projects/${projectId}/collaboration-asset`, { path, revision: revision ?? '' });
    return { content: [{ type: 'image' as const, data: asset.data, mimeType: asset.mimeType }, { type: 'text' as const, text: JSON.stringify({ path: asset.path, revision: asset.revision, bytes: asset.bytes, hash: asset.hash }) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
});

server.registerTool('cewen_publish_questions', { description: '发布独立问题与推荐方案，用户在策问作答。不得代填用户答案。', inputSchema: { projectId: project, requestId: z.string(), round: z.string(), questions: z.array(z.object({ id: z.string(), title: z.string(), background: z.string(), options: z.array(z.string()), targets: z.array(z.string()), mode: z.enum(['single','multiple']).optional(), follows: z.string().optional(), condition: z.string().optional(), when: z.object({ questionId: z.string(), option: z.string().optional() }).optional() })).min(1).max(30) } }, ({ projectId, ...input }) => result(() => client.request(`/api/projects/${projectId}/questions`, input)));
server.registerTool('cewen_propose', { description: '暂存公开 Markdown 或受控伴随 JSON 的修改提案，由用户在软件核对并采纳。不会直接改正式文档，也不接受二进制附件。', inputSchema: { projectId: project, proposal: z.object({ id: z.string(), title: z.string(), reason: z.string(), baseRevision: z.string(), questionIds: z.array(z.string()), dependencies: z.record(z.string(), z.string()), changes: z.array(z.object({ path: z.string(), baseHash: z.string().nullable(), text: z.string().nullable() })) }) } }, ({ projectId, proposal }) => result(() => client.request(`/api/projects/${projectId}/proposals`, proposal)));
server.registerTool('cewen_prepare_import', { description: '预检用户指定的 Markdown 目录，只生成暂存候选；用户在策问确认映射后应用。', inputSchema: { projectId: project, directory: z.string() } }, ({ projectId, directory }) => result(() => client.request(`/api/projects/${projectId}/import-plan`, { directory })));

server.registerTool('cewen_checkpoint', { description: '用户已授权直接修改当前公开文件且本轮落盘完成后，显式保存公开版本。不会替模型修改正文或批准提案。', inputSchema: { projectId: project, requestId: z.string(), reason: z.string() } }, ({ projectId, ...input }) => result(() => client.request(`/api/projects/${projectId}/checkpoint`, input)));
server.registerTool('cewen_begin_batch', { description: '用户授权外部工具直接写多个公开文件前开始一轮，自动同步暂不发布中途版本。必须在落盘完成后结束。', inputSchema: { projectId: project, requestId: z.string() } }, ({ projectId, ...input }) => result(() => client.request(`/api/projects/${projectId}/begin-batch`, input)));
server.registerTool('cewen_end_batch', { description: '验证已完成的外部文件批次并创建一个版本。格式错误会保留批次供修正后重试。', inputSchema: { projectId: project, batch: z.string(), reason: z.string() } }, ({ projectId, ...input }) => result(() => client.request(`/api/projects/${projectId}/end-batch`, input)));

await server.connect(new StdioServerTransport());
