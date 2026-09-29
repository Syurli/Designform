import { mkdir, readFile, writeFile } from './platform';
import { APP_VERSION } from '../shared/version';

/** 缓存包属于浏览器可清除数据；项目中的副本才是用户可启动的接入程序。 */
export interface ConnectorManifest { version: string; platform: 'win-x64'; size: number; sha256: string; nodeVersion: string }
export interface ConnectorSession { projectId: string; projectPath: string; url: string; token: string }
const sessions = new Map<string, ConnectorSession>();
const connectivity = new Map<string, boolean>();
export function connectorConnected(id: string) { return Boolean(sessions.has(id) && connectivity.get(id)); }
function markConnectivity(id: string, connected: boolean) { if (connectivity.get(id) === connected) return; connectivity.set(id, connected); window.dispatchEvent(new CustomEvent('cewen:connector-status', { detail: { projectId: id, connected } })); }
const assets = new Map<string, { hash: string; url: string }>();
/** 同步图片渲染使用已鉴权获取的 Blob，按快照哈希更新。 */
export function connectorAssetUrl(id: string, filename: string, revision = 'current') { return assets.get(`${id}:${revision}:${filename}`)?.url ?? ''; }
export async function prepareConnectorSnapshot<T>(result: T): Promise<T> {
  if (!result || typeof result !== 'object' || !('project' in result) || !('files' in result)) return result;
  const snapshot = result as unknown as import('../shared/model').ProjectSnapshot, session = connectorSession(snapshot.project.id);
  if (!session) return result;
  for (const [filename, hash] of Object.entries(snapshot.files ?? {})) {
    if (!filename.startsWith('docs/assets/')) continue;
    const revision = snapshot.historical ? snapshot.revision! : 'current', key = `${snapshot.project.id}:${revision}:${filename}`, cached = assets.get(key);
    if (cached?.hash === hash) continue;
    const response = await connectorFetch(session, `/api/projects/${snapshot.project.id}/asset?path=${encodeURIComponent(filename)}${snapshot.historical ? `&revision=${encodeURIComponent(revision)}` : ''}`);
    if (!response.ok) throw new Error('本项目附件读取失败，服务可能已断开。');
    if (cached) URL.revokeObjectURL(cached.url); assets.set(key, { hash, url: URL.createObjectURL(await response.blob()) });
  }
  return result;
}
let download: Promise<ConnectorManifest> | undefined;
let downloadController: AbortController | undefined;
window.addEventListener('pagehide', () => downloadController?.abort());
export type ConnectorPackageState = 'idle' | 'downloading' | 'ready' | 'failed';
let packageState: ConnectorPackageState = 'idle';
let progress = { received: 0, total: 0 };
export function connectorPackageProgress() { return { ...progress }; }
/** 面板可订阅真实下载状态；ready 只在大小与哈希同时验证后产生。 */
export function connectorPackageState() { return packageState; }
function setPackageState(value: ConnectorPackageState) { packageState = value; window.dispatchEvent(new CustomEvent('cewen-connector-package', { detail: value })); }
const cache = '/app/connector-cache';
export function connectorSession(id?: string) { return id ? sessions.get(id) : undefined; }
export function latestConnectorSession() { return [...sessions.values()].at(-1); }
export function connectorRoute(route: string, write = false) { const id = /^\/api\/projects\/([^/?]+)/.exec(route)?.[1], pathname = route.split('?')[0]; return id ? connectorSession(id) : ['/api/integration', '/api/connections', '/api/creative-capabilities'].includes(pathname) || !write && ['/api/projects', '/api/document-presets', '/api/fonts'].includes(pathname) ? latestConnectorSession() : undefined; }
export async function connectorFetch(session: ConnectorSession, route: string, init: RequestInit = {}) {
  // 配对之后的失败必须显式呈现，绝不回落到浏览器 ProjectService。
  try { const response = await fetch(session.url + route, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'X-Cewen-Session': session.token } }); markConnectivity(session.projectId, response.status !== 403); return response; }
  catch (error) { if (!init.signal?.aborted) markConnectivity(session.projectId, false); throw error; }
}
/** 用户同意后调用；下载被关闭页面打断时，下次重新获取完整包并校验。 */
export function prepareConnectorPackage(force = false) {
  // 人工“重新校验”确实重读缓存；当前页面缓存被清除后也能重新下载。
  if (force && packageState !== 'downloading') download = undefined;
  return download ??= (async () => {
    setPackageState('downloading');
    downloadController = new AbortController();
    const base = new URL(import.meta.env.BASE_URL, location.origin);
    const manifestResponse = await fetch(new URL('connector.manifest.json', base), { cache: 'no-cache', signal: downloadController.signal });
    if (!manifestResponse.ok) throw new Error('接入包清单尚未发布，请稍后重试。');
    const manifest = await manifestResponse.json() as ConnectorManifest;
    // 页面与运行包必须属于同一发行版本，拒绝 CDN 更新交错时混装环境。
    if (manifest.version !== APP_VERSION) throw new Error('网页与接入包版本不一致，请刷新网页后重试。');
    if (manifest.platform !== 'win-x64' || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('接入包清单无效。');
    progress = { received: 0, total: manifest.size };
    let bytes: Uint8Array;
    try { bytes = await readFile(cache + '/connector.zip'); } catch { bytes = new Uint8Array(); }
    const valid = async (value: Uint8Array) => value.byteLength === manifest.size && [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value)))].map(n => n.toString(16).padStart(2, '0')).join('') === manifest.sha256;
    if (!await valid(bytes)) {
      const response = await fetch(new URL('connector.zip', base), { signal: downloadController.signal });
      if (!response.ok) throw new Error('接入包下载失败，可稍后重新下载。');
      const reader = response.body?.getReader(); if (!reader) throw new Error('接入包响应没有可读取内容。');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > manifest.size) { await reader.cancel(); throw new Error('接入包实际大小超过清单，请重试。'); } chunks.push(part.value); progress.received = length; window.dispatchEvent(new CustomEvent('cewen-connector-package', { detail: packageState })); }
      bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (!await valid(bytes)) throw new Error('接入包大小或 SHA-256 校验失败，请重试。');
      await mkdir(cache, { recursive: true }); await writeFile(cache + '/connector.zip', bytes);
    }
    progress.received = manifest.size; await writeFile(cache + '/manifest.json', JSON.stringify(manifest)); setPackageState('ready'); return manifest;
  })().catch(error => { download = undefined; setPackageState('failed'); throw error; });
}
/** 程序只作为整包复制到项目私有目录，不向项目散写可执行文件。 */
export async function installProjectConnector(projectPath: string, projectId: string) {
  const manifest = await prepareConnectorPackage(), directory = projectPath + '/.cewen/connector';
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/connector.zip', await readFile(cache + '/connector.zip'));
  await writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2));
  await writeFile(directory + '/project.json', JSON.stringify({ projectId, pagesOrigin: location.origin }, null, 2));
  // Chromium 可能禁止直接写入 cmd/bat 等危险扩展；网页只落盘整包和数据说明。
  await writeFile(directory + '/使用说明.md', '# 网页本机接入\n\n1. 将本目录 connector.zip 解压到同级 runtime 子目录。正确布局是 .cewen/connector/runtime/node.exe（不是 runtime/runtime/node.exe）。\n2. 双击 runtime/启动接入.cmd，在后台启动本项目服务。网页会自动检测本目录 connection.json 回执；也可读取其中的 url 和 pairingCode，在网页接入面板填写并配对。\n3. 配对码五分钟内有效且只能使用一次；重新双击 runtime/启动接入.cmd 会续发。\n4. MCP 客户端启动命令为 runtime/策问MCP.cmd，或者 runtime/node.exe 加参数 runtime/bootstrap.js。无需手改项目配置 JSON。\n\n网页不会直接写入 cmd/bat/exe，启动脚本均在完整 ZIP 中，解压由你或本机工具执行。项目资料不会上传 GitHub Pages。缓存丢失可重新下载。\n');
  return { directory, manifest };
}
/** 接入信息由项目私有回执人工带入，公开网页不会扫描本机端口。 */
export async function pairProjectConnector(projectId: string, url: string, pairingCode: string) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password) throw new Error('请填写项目回执中的本机服务地址。');
  const response = await fetch(address.origin + '/connector/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, pairingCode }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? '项目配对失败。');
  const session = { ...result, url: address.origin } as ConnectorSession; sessions.set(projectId, session); markConnectivity(projectId, true); return session;
}
