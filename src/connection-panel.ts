import type { LlmConnectionState, ProjectSnapshot } from '../shared/model.ts';
import { isWebEdition, releaseUrl } from './edition';
import { escapeHtml as html } from './markdown-view';
import { readConnections, request } from './project-client';
import { composeConnectionPrompt, type IntegrationInfo } from '../shared/prompts.ts';

/** 顶部常驻摘要与详情面板共用真实心跳状态，不把浏览器在线误当成 LLM 已连接。 */
export class ConnectionPanel {
  private dialog = document.createElement('dialog');
  private data?: LlmConnectionState;
  private error = '';
  private busy = false;
  private promptEpoch = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private trigger: HTMLButtonElement, private snapshot: () => ProjectSnapshot | undefined) {
    this.dialog.className = 'project-dialog connection-dialog'; this.dialog.setAttribute('aria-label', 'LLM 连接与接入'); document.body.append(this.dialog);
    trigger.addEventListener('click', () => { this.renderDialog(); this.dialog.showModal(); void this.refresh(); });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.dataset.connectionAction === 'close') this.dialog.close();
      if (button.dataset.connectionAction === 'refresh') void this.refresh();
      if (button.dataset.connectionAction === 'copy-prompt') void this.copyPrompt();
      if (button.dataset.connectionAction === 'retry-prompt') void this.preparePrompt();
    });
    document.addEventListener('visibilitychange', this.visible);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, 4000);
    void this.refresh();
  }
  private visible = () => { if (!document.hidden) void this.refresh(); };
  private async refresh() {
    if (this.busy) return; this.busy = true;
    try { this.data = await readConnections(); this.error = ''; }
    catch (error) { this.error = error instanceof Error ? error.message : '暂时无法取得连接状态。'; }
    finally { this.busy = false; this.renderSummary(); if (this.dialog.open) this.renderRows(); }
  }
  private renderSummary() {
    const connected = this.data?.connections.filter(item => item.status === 'connected') ?? [], current = connected.find(item => item.projectId === this.snapshot()?.project.id) ?? connected[0];
    const state = this.error ? 'unknown' : current ? 'connected' : 'disconnected';
    const name = this.error ? '状态暂不可用' : current ? current.modelName || current.clientName : '未连接 LLM';
    const detail = this.error ? '点击查看连接' : current ? `${connected.length > 1 ? `${connected.length} 个连接 · ` : ''}已连接${current.modelName ? '' : ' · 模型未提供'}` : '接入与连接状态';
    this.trigger.dataset.state = state;
    this.trigger.innerHTML = `<span class="connection-dot"></span><span><strong>${html(name)}</strong><small>${html(detail)}</small></span><span class="connection-chevron">⌄</span>`;
    this.trigger.title = `${name} · ${detail}`; this.trigger.setAttribute('aria-label', `LLM 连接：${name}，${detail}`);
  }
  private renderDialog() {
    const snapshot=this.snapshot();
    this.dialog.innerHTML = `<header class="project-dialog-header"><div><h1>${isWebEdition?'与 LLM 通过文件协作':'连接 LLM'}</h1><p>${isWebEdition?'复制说明后发送给 LLM，按需分享公开文档。':'复制开场白，发送给你正在使用的 LLM。'}</p></div><button class="icon-button" data-connection-action="close" aria-label="关闭连接面板">×</button></header><p class="connection-project">${snapshot?`当前项目 · ${html(snapshot.project.name)}`:'尚未选择项目，可以先连接工具。'}</p><button class="primary-button connection-copy" data-connection-action="copy-prompt" disabled>${isWebEdition?'复制文件协作开场白':'复制 MCP 接入开场白'}</button><p class="quiet connection-copy-status" role="status">正在准备接入信息…</p><button class="secondary-button" data-connection-action="retry-prompt" hidden>重新准备</button><details class="connection-preview"><summary>查看或修改开场白</summary><textarea aria-label="接入开场白" rows="9" spellcheck="false"></textarea></details>${isWebEdition?'<p class="quiet">网页版通过本机文档或上下文包协作，不提供持续在线的 MCP 通道。</p><a href="'+releaseUrl+'" target="_blank" rel="noopener noreferrer">下载桌面版</a>':'<div class="connection-status-heading"><h2>连接状态</h2><button class="secondary-button" data-connection-action="refresh">刷新</button></div><div id="connection-rows" aria-live="polite"></div>'}`;
    this.renderRows();
    void this.preparePrompt();
  }

  /** 先准备真实接入信息，按钮点击时直接调用剪贴板，避免再弹通用表单。 */
  private async preparePrompt() {
    const epoch=++this.promptEpoch,button=this.dialog.querySelector<HTMLButtonElement>('[data-connection-action="copy-prompt"]')!,area=this.dialog.querySelector<HTMLTextAreaElement>('textarea')!,status=this.dialog.querySelector<HTMLElement>('[role="status"]')!,retry=this.dialog.querySelector<HTMLButtonElement>('[data-connection-action="retry-prompt"]')!;
    button.disabled=true;retry.hidden=true;status.textContent='正在准备接入信息…';
    try {const info=await request<IntegrationInfo>('/api/integration');if(epoch!==this.promptEpoch)return;area.value=composeConnectionPrompt(this.snapshot(),info);button.disabled=false;status.textContent=isWebEdition?'只需复制并发送，无需设置参数。':'只负责连接检查；复制后等待模型接入，状态会自动更新。';}
    catch {if(epoch!==this.promptEpoch)return;status.textContent='暂时无法获取接入位置，请重新准备。';retry.hidden=false;}
  }

  /** 复制失败时只展开当前面板内的全文，保留一个明确的手动复制入口。 */
  private async copyPrompt() {
    const area=this.dialog.querySelector<HTMLTextAreaElement>('textarea')!,status=this.dialog.querySelector<HTMLElement>('[role="status"]')!;
    try {await navigator.clipboard.writeText(area.value);status.textContent='已复制。请粘贴到 LLM 对话中发送。';}
    catch {this.dialog.querySelector<HTMLDetailsElement>('.connection-preview')!.open=true;area.focus();area.select();status.textContent='未能自动复制，已选中全文，请按 Ctrl+C。';}
  }
  private renderRows() {
    const rows = this.dialog.querySelector('#connection-rows'); if (!rows) return;
    if (this.error) { rows.innerHTML = `<p class="connection-empty">连接状态暂不可用。${html(this.error)}</p>`; return; }
    const connections = this.data?.connections ?? [];
    rows.innerHTML = (connections.length ? connections.map(item => {
      const here = item.projectId && item.projectId === this.snapshot()?.project.id;
      return `<article class="connection-row"><header><span class="connection-dot ${item.status}"></span><strong>${html(item.modelName || item.clientName)}</strong><span>${item.status === 'connected' ? '已连接' : '已断开'}</span></header><dl><dt>客户端</dt><dd>${html(item.clientName)} ${html(item.clientVersion)}</dd><dt>模型</dt><dd>${html(item.modelName || '客户端未提供模型名称')}${item.modelName ? ` <small>（${item.modelSource === 'configured' ? '连接配置' : '客户端自报'}）</small>` : ''}</dd><dt>项目访问</dt><dd>${here ? `最近访问：${html(this.snapshot()!.project.name)}` : item.projectId ? '最近访问其他项目' : '尚未访问项目'}</dd><dt>最近活动</dt><dd>${item.lastActivityAt ? html(new Date(item.lastActivityAt).toLocaleString()) : '尚未调用项目工具'}</dd></dl></article>`;
    }).join('') : '<div class="connection-empty"><strong>尚未连接 LLM</strong><p>模型完成接入后，这里会显示名称和连接状态。</p></div>') + '<p class="connection-explanation">状态来自实际 MCP 连接；复制开场白不会显示为已连接。</p>';
  }
  dispose() { clearInterval(this.timer); document.removeEventListener('visibilitychange', this.visible); this.dialog.remove(); }
}
