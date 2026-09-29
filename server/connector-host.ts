import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProjectApi } from './http';

/** 仅此宿主持有项目服务；多个 MCP 进程通过回执附着，避免多写入者。 */
const installation = path.dirname(fileURLToPath(import.meta.url));
const privateRoot = path.resolve(installation, '..');
const projectRoot = await realpath(path.resolve(privateRoot, '../..'));
// Pages 使用独立本机数据根，不检测或复用桌面 App；路径哈希隔离每个实际项目。
const pathIdentity = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
const projectDirectoryHash = createHash('sha256').update(pathIdentity).digest('hex');
const localData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const connectorDataRoot = path.resolve(process.env.CEWEN_CONNECTOR_HOME ?? path.join(localData, '策问Pages'));
const serviceHome = path.join(connectorDataRoot, projectDirectoryHash);
const insideProject = path.relative(projectRoot, serviceHome);
if (!insideProject || !insideProject.startsWith('..' + path.sep) && insideProject !== '..' && !path.isAbsolute(insideProject)) throw new Error('Pages 接入数据目录必须位于项目外部，以保证自动备份不会递归包含自身。');
const configuration = JSON.parse(await readFile(path.join(privateRoot, 'project.json'), 'utf8')) as { projectId: string; pagesOrigin: string };
if (new URL(configuration.pagesOrigin).origin !== configuration.pagesOrigin || !/^https:\/\//.test(configuration.pagesOrigin)) throw new Error('项目 Pages 来源必须为精确 HTTPS origin。');
await mkdir(privateRoot, { recursive: true });
const lock = path.join(privateRoot, 'host.lock');
try {
  const pid = Number(await readFile(lock, 'utf8')); let alive = false;
  try { if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch { /* 旧宿主已退出。 */ }
  if (alive) {
    // 活宿主启动途中没有回执时也不能删锁，避免形成第二个项目写入者。
    try { const receipt = JSON.parse(await readFile(path.join(privateRoot, 'connection.json'), 'utf8')); await fetch(receipt.nativeUrl + '/connector/renew', { method: 'POST', headers: { 'X-Cewen-Control': receipt.controlToken } }); } catch { /* 用户可在启动完成后再点一次入口。 */ }
    process.exit(0);
  }
  await unlink(lock);
} catch { /* 首次启动没有锁。 */ }
try { await writeFile(lock, String(process.pid), { flag: 'wx' }); } catch { process.exit(0); }
const internalToken = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
let pairingCode = randomBytes(16).toString('hex'), expiresAt = Date.now() + 5 * 60_000;
const api = createProjectApi({ home: serviceHome, root: installation, installation: privateRoot, sessionToken: internalToken, projectId: configuration.projectId });
const project = await api.service.open(projectRoot);
if (project.id !== configuration.projectId) throw new Error('启动配置与项目身份不一致。');
/** 本机 MCP 仍需原 API 会话鉴权；端口仅记录在项目私有回执中。 */
const native = createServer((request, response) => {
  if (request.url === '/connector/renew' && request.method === 'POST') {
    if (request.headers.origin || request.headers['x-cewen-control'] !== controlToken) { response.writeHead(403); response.end(); return; }
    pairingCode = randomBytes(16).toString('hex'); expiresAt = Date.now() + 5 * 60_000;
    void saveReceipt().then(() => { response.writeHead(204); response.end(); }); return;
  }
  void api.handle(request, response);
});
await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
const nativePort = (native.address() as { port: number }).port;
const send = (response: import('node:http').ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const host = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin !== configuration.pagesOrigin || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) { send(response, { error: { message: '接入来源不匹配。' } }, 403); return; }
  response.setHeader('Access-Control-Allow-Origin', configuration.pagesOrigin); response.setHeader('Vary', 'Origin');
  if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cewen-Session'); response.setHeader('Access-Control-Allow-Private-Network', 'true'); response.writeHead(204); response.end(); return; }
  if (request.url === '/connector/pair' && request.method === 'POST') {
    let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 4096) { send(response, { error: { message: '配对请求过大。' } }, 400); return; } }
    try { const input = JSON.parse(text); if (!pairingCode || Date.now() > expiresAt || input.pairingCode !== pairingCode || input.projectId !== project.id) throw new Error(); pairingCode = ''; send(response, { projectId: project.id, projectPath: projectRoot, token }); } catch { send(response, { error: { message: '配对码无效、已使用或已过期，请重新启动接入。' } }, 403); } return;
  }
  if (request.headers['x-cewen-session'] !== token) { send(response, { error: { code: 'SESSION_REQUIRED', message: '请先配对本项目。' } }, 403); return; }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/api/projects' && request.method === 'GET') { send(response, { projects: [project], current: project.id, defaultDirectory: projectRoot }); return; }
  if (url.pathname === '/api/integration') { send(response, { mode: 'local', root: installation, runtime: path.join(installation, 'bootstrap.js'), launcher: path.join(installation, '策问MCP.cmd'), skill: path.join(installation, 'integration/skills/cewen-collaborate/SKILL.md'), guide: path.join(privateRoot, '使用说明.md') }); return; }
  const match = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
  const forbidden = new Set(['copy', 'export', 'delete', 'forget', 'upgrade-copy', 'import-plan']);
  const safeGlobalRead = request.method === 'GET' && ['/api/connections', '/api/creative-capabilities', '/api/document-presets', '/api/fonts'].includes(url.pathname);
  if (!(match && match[1] === project.id && !forbidden.has(match[2] ?? '')) && !safeGlobalRead && !(url.pathname === '/api/connections' && request.method === 'POST')) { send(response, { error: { message: '接入仅允许当前项目。' } }, 403); return; }
  // 外层已经校验精确来源、项目身份和独立会话；内部继续验证 API token。
  request.headers.origin = `http://${request.headers.host}`; delete request.headers['sec-fetch-site']; request.headers['x-cewen-session'] = internalToken;
  await api.handle(request, response);
});
await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
async function saveReceipt() { await writeFile(path.join(privateRoot, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${(host.address() as { port: number }).port}`, nativeUrl: `http://127.0.0.1:${nativePort}`, controlToken, pairingCode, expiresAt, pid: process.pid, projectId: project.id }, null, 2)); }
await saveReceipt();
/** 正常退出清除锁；崩溃留下的锁由下一次启动核对 PID。 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void unlink(lock).finally(() => process.exit(0)); });
