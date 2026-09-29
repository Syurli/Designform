import './connector-panel.css';
import { isWebEdition } from './edition';
import { isTransientProject } from '../shared/transient';
import type { ProjectSnapshot } from '../shared/model';
import { readFile } from '../browser/platform';
import { connectorPackageState, connectorPackageProgress, prepareConnectorPackage, installProjectConnector, pairProjectConnector, connectorSession, connectorConnected, type ConnectorManifest } from '../browser/connector';

/** 页面只保留接入状态和授权记忆；配对 token 从不写入 localStorage。 */
let initialized = false, consent = false, later = false, active: ProjectSnapshot | undefined, manifest: ConnectorManifest | undefined;
let panel: HTMLDialogElement, trigger: HTMLButtonElement, failure = '', operation = false;
const deployed = new Map<string, string>();
let edited = false;
let takeoverGuard: (() => boolean) | undefined;
/** 主编辑器可提供严格草稿检查；存在未保存操作时只显示待接管，不自动切服务。 */
export function setConnectorTakeoverGuard(guard: () => boolean) { takeoverGuard = guard; }
const html = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const supported = () => /Windows/i.test(navigator.userAgent) && /Win64|x64|WOW64/i.test(navigator.userAgent) && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
function status() {
  if (failure) return failure;
  if (active && connectorSession(active.project.id)) return connectorConnected(active.project.id) ? '本项目已由本机接入服务管理' : '本项目服务已断开，保留页面草稿。请重新启动并检测连接；不会退回网页文件服务。';
  if (!supported()) return '本机接入首版仅支持 Windows x64 的 Chrome / Edge。当前浏览器可先人工使用。';
  if (operation) return '正在将完整接入包复制到项目私有目录…';
  if (active && deployed.has(active.project.id)) return '包已写入项目，请将 connector.zip 解压到同级 runtime 子目录，再双击 runtime/启动接入.cmd';
  const state = connectorPackageState(); return state === 'downloading' ? '后台下载中，关闭页面会中断，可下次重试' : state === 'ready' ? '环境包已校验，打开正式项目后部署接入' : state === 'failed' ? '下载失败，请重试；仍可人工编辑项目' : later ? '已选择稍后，仍可人工编辑项目' : '等待同意下载本机接入环境';
}
function render() {
  if (!initialized) return;
  trigger.textContent = active && connectorSession(active.project.id) ? connectorConnected(active.project.id) ? '本机接入 · 已连接' : '本机接入 · 已断开' : '本机接入';
  const progress = connectorPackageProgress(), busy = connectorPackageState() === 'downloading';
  const focused = panel.querySelector<HTMLInputElement>('[name="url"]'), focusedCode = panel.querySelector<HTMLInputElement>('[name="pairingCode"]');
  const url = focused?.value ?? '', code = focusedCode?.value ?? '';
  panel.innerHTML = `<header class="project-dialog-header"><div><h1>本机接入环境</h1><p>GitHub Pages · Windows x64 · Chrome / Edge</p></div><button class="icon-button" data-connector="close" aria-label="关闭">×</button></header><p>下载 ${manifest ? `<strong>${html(manifest.version)} · ${size(manifest.size)}</strong>` : '固定版本环境包（正在读取大小与版本）'}，包含 Node 24、项目后台服务和 MCP 接入。程序仅部署到你选择的项目，项目文档保存在本机。</p><p>下载缓存可以清除；关闭页面会中断下载，可重新打开后重试。</p><p role="status" class="connector-state">${html(status())}</p>${busy ? `<progress max="${progress.total || 1}" value="${progress.received}"></progress><p class="quiet">${size(progress.received)} / ${size(progress.total)}</p>` : ''}<div class="connector-actions"><button class="primary-button" data-connector="download" ${busy || !supported() ? 'disabled' : ''}>${connectorPackageState() === 'ready' ? '重新校验环境' : connectorPackageState() === 'failed' ? '重试下载' : '同意下载'}</button><button class="secondary-button" data-connector="later">稍后，先人工使用</button></div>${active && !isTransientProject(active.project.id) ? `<section><h2>当前项目 · ${html(active.project.name)}</h2><p>环境包就绪后会复制到 <code>.cewen/connector</code>。将 connector.zip 解压到同级 runtime 子目录，再双击 runtime/启动接入.cmd，后台服务会生成私有回执；网页检测到回执后配对。有未保存编辑时先保存，再明确接管。</p><div class="connector-actions"><button class="secondary-button" data-connector="deploy" ${busy || operation ? 'disabled' : ''}>部署或重试接入</button><button class="secondary-button" data-connector="detect">检测并连接此项目</button></div><details><summary>手动输入项目回执</summary><label>本机服务地址<input name="url" placeholder="http://127.0.0.1:端口" value="${html(url)}"></label><label>一次配对码<input name="pairingCode" value="${html(code)}" autocomplete="off"></label><button class="secondary-button" data-connector="pair">连接并接管此项目</button></details></section>` : '<p class="quiet">创建或打开正式项目后，可部署并连接本项目。浏览示例无需安装。</p>'}`;
}
export function openConnectorPanel() { initializeConnectorPanel(); if (!isWebEdition) return; render(); if (!panel.open) panel.showModal(); }
/** 连接区可插入同一入口，不另造第二套接入设置。 */
export function mountConnectorEntry(container: HTMLElement) { if (!isWebEdition || container.querySelector('[data-open-connector]')) return; const button = document.createElement('button'); button.className = 'secondary-button'; button.dataset.openConnector = ''; button.textContent = '配置本机项目接入'; button.onclick = openConnectorPanel; container.append(button); }
export function initializeConnectorPanel() {
  if (!isWebEdition || initialized) return; initialized = true;
  try { consent = localStorage.getItem('cewen-connector-consent') === 'yes'; later = localStorage.getItem('cewen-connector-later') === 'yes'; } catch { /* 受限存储只影响下次是否再询问。 */ }
  panel = document.createElement('dialog'); panel.className = 'project-dialog connector-dialog'; panel.setAttribute('aria-label', '本机接入环境'); document.body.append(panel);
  trigger = document.createElement('button'); trigger.className = 'secondary-button connector-environment-trigger'; trigger.onclick = openConnectorPanel; document.body.append(trigger);
  document.addEventListener('input', event => { if (active && !(event.target as HTMLElement).closest('.connector-dialog')) edited = true; });
  window.addEventListener('cewen-connector-package', () => { render(); if (connectorPackageState() === 'ready') void deployActive(); });
  window.addEventListener('cewen:connector-status', render);
  panel.addEventListener('click', event => { const action = (event.target as HTMLElement).closest<HTMLElement>('[data-connector]')?.dataset.connector; if (!action) return;
    if (action === 'close') { panel.close(); return; }
    if (action === 'later') { later = true; try { localStorage.setItem('cewen-connector-later', 'yes'); } catch { /* 本次记忆仍生效。 */ } panel.close(); render(); return; }
    if (action === 'download') { consent = true; later = false; failure = ''; try { localStorage.setItem('cewen-connector-consent', 'yes'); localStorage.removeItem('cewen-connector-later'); } catch { /* 本次授权仍生效。 */ } void prepareConnectorPackage(true).catch(error => { failure = error.message; render(); }); return; }
    if (action === 'deploy') { void deployActive(); return; }
    if (action === 'detect') { void detectReceipt(true); return; }
    if (action === 'pair') { const url = panel.querySelector<HTMLInputElement>('[name="url"]')?.value ?? '', code = panel.querySelector<HTMLInputElement>('[name="pairingCode"]')?.value ?? ''; void connect(url, code); }
  });
  const base = new URL(import.meta.env.BASE_URL, location.origin);
  void fetch(new URL('connector.manifest.json', base), { cache: 'no-cache' }).then(async response => { if (!response.ok) throw new Error('当前网页尚未发布接入包，可稍后重试。'); manifest = await response.json(); render(); }).catch(error => { failure = error.message; render(); });
  render(); if (consent && supported()) void prepareConnectorPackage().catch(error => { failure = error.message; render(); }); else if (!later) panel.showModal();
  window.setInterval(() => { if (consent && !later && active && !connectorSession(active.project.id)) void detectReceipt(false); }, 2500);
}
/** main 只在项目应用时通知；部署失败不会阻断项目创建、打开或人工编辑。 */
export function onConnectorProject(snapshot: ProjectSnapshot) {
  initializeConnectorPanel(); if (!isWebEdition) return;
  if (isTransientProject(snapshot.project.id)) { active = undefined; render(); return; }
  if (active?.project.id !== snapshot.project.id) edited = false; active = snapshot; render();
  if (consent && connectorPackageState() === 'ready') void deployActive();
}
async function deployActive() {
  const snapshot = active; if (!snapshot || !consent || operation || connectorPackageState() !== 'ready' || connectorSession(snapshot.project.id) || deployed.has(snapshot.project.id)) return;
  operation = true; failure = ''; render();
  try { await installProjectConnector(snapshot.project.path, snapshot.project.id); deployed.set(snapshot.project.id, snapshot.project.path); }
  catch (error) { failure = `接入环境未部署：${(error as Error).message}。可继续人工编辑，稍后重试。`; }
  finally { operation = false; render(); }
}
async function detectReceipt(explicit: boolean) {
  const snapshot = active; if (!snapshot || operation || !explicit && connectorSession(snapshot.project.id)) return;
  const root = deployed.get(snapshot.project.id) ?? snapshot.project.path;
  try { const receipt = JSON.parse((await readFile(root + '/.cewen/connector/connection.json')).toString('utf8'));
    if (receipt.projectId !== snapshot.project.id || Date.now() >= receipt.expiresAt || !receipt.pairingCode) { if (explicit) { failure = '本项目回执无效、已使用或已过期。请重新双击 runtime/启动接入.cmd续发配对码，再检测连接。'; render(); } return; }
    if (!explicit && (edited || takeoverGuard && !takeoverGuard())) { const message = '已检测到本项目服务。有未保存编辑，请先保存，再点“检测并连接此项目”。'; if (failure !== message) { failure = message; render(); } return; }
    await connect(receipt.url, receipt.pairingCode);
  } catch (error) { if (explicit) { failure = `尚未找到有效服务回执：${(error as Error).message}。请先解压接入包，再双击本项目 runtime/启动接入.cmd。`; render(); } }
}
async function connect(url: string, pairingCode: string) {
  const snapshot = active; if (!snapshot || operation) return;
  if (takeoverGuard && !takeoverGuard()) { failure = '请先保存或处理当前未保存编辑，再连接本项目服务。'; render(); return; }
  operation = true; render();
  try { const session = await pairProjectConnector(snapshot.project.id, url, pairingCode); failure = ''; window.dispatchEvent(new CustomEvent('cewen:connector-paired', { detail: session })); }
  catch (error) { failure = `配对未成功：${(error as Error).message}。${connectorSession(snapshot.project.id) ? '当前保持本机接管，未退回网页文件服务。' : '当前仍使用网页人工文件模式。'}`; }
  finally { operation = false; render(); }
}
