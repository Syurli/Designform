import type { LlmConnectionState, ProjectSnapshot } from '../shared/model.ts';
import { isWebEdition, releaseUrl } from './edition';
import { escapeHtml as html } from './markdown-view';
import { readConnections } from './project-client';

/** 顶部常驻摘要与详情面板共用真实心跳状态，不把浏览器在线误当成 LLM 已连接。 */
export class ConnectionPanel {
  private dialog = document.createElement('dialog');
  private data?: LlmConnectionState;
  private error = '';
  private busy = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private trigger: HTMLButtonElement, private snapshot: () => ProjectSnapshot | undefined) {
    this.dialog.className = 'project-dialog connection-dialog'; this.dialog.setAttribute('aria-label', 'LLM 连接与接入'); document.body.append(this.dialog);
    trigger.addEventListener('click', () => { this.renderDialog(); this.dialog.showModal(); void this.refresh(); });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.dataset.connectionAction === 'close') this.dialog.close();
      if (button.dataset.connectionAction === 'refresh') void this.refresh();
      if (button.dataset.connectionAction === 'copy') void navigator.clipboard.writeText(this.configuration()).then(() => { button.textContent = '已复制，请替换安装路径'; }).catch(() => { button.textContent = '复制失败，请选择下方配置手动复制'; });
    });
    document.addEventListener('visibilitychange', this.visible);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, 4000);
    void this.refresh();
  }
  private visible = () => { if (!document.hidden) void this.refresh(); };
  private configuration() {
    return JSON.stringify({ mcpServers: { cewen: { command: 'cmd.exe', args: ['/d','/s','/c','"D:\\替换为策问安装目录\\策问MCP.cmd"'], env: { CEWEN_URL: location.origin } } } }, null, 2);
  }
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
    if (isWebEdition) {
      this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">FILE COLLABORATION</span><h1>通过本机文档与 LLM 协作</h1><p>网页版没有后台 MCP 通道，当前没有持续在线的模型连接。</p></div><button class="icon-button" data-connection-action="close" aria-label="关闭连接面板">×</button></header><p>把已授权项目目录中的 PROJECT.md、docs 和 versions 交给你使用的 LLM。文件修改后，策问会扫描并更新知识网；也可以在“资料交换”中导出上下文、接收问询和修改提案。</p><p>需要 MCP 实时协作时，请使用桌面版并按其中的连接说明配置客户端。</p><a class="secondary-button" href="${releaseUrl}" target="_blank" rel="noopener noreferrer">下载桌面版</a><p class="quiet">网页不会上传文档，也不会因为文件正在被读取就显示模型在线。</p>`;
      return;
    }
    this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">LLM CONNECTION</span><h1>协作连接</h1><p>查看已接入策问的客户端、模型名称与连接状态。</p></div><button class="icon-button" data-connection-action="close" aria-label="关闭连接面板">×</button></header><div id="connection-rows" aria-live="polite"></div><button class="secondary-button" data-connection-action="refresh">刷新连接状态</button><details class="connection-setup"><summary>接入一个 LLM 客户端</summary><p>在支持 MCP 的客户端添加策问。复制下方配置，将安装目录替换为便携包解压位置，并保持策问运行。</p><button class="secondary-button" data-connection-action="copy">复制 MCP 配置</button><textarea aria-label="MCP 接入配置" readonly spellcheck="false">${html(this.configuration())}</textarea><p>如需指定实际模型名，可在配置 env 中添加 <code>CEWEN_LLM_NAME</code>；支持的模型也可调用 <code>cewen_identify</code> 报告自身名称。未提供时会明确显示“模型未提供”。</p><p>通过文件或 CLI 协作不建立持续的 LLM 连接，不会显示为在线。</p></details>`;
    this.renderRows();
  }
  private renderRows() {
    const rows = this.dialog.querySelector('#connection-rows'); if (!rows) return;
    if (this.error) { rows.innerHTML = `<p class="connection-empty">连接状态暂不可用。${html(this.error)}</p>`; return; }
    const connections = this.data?.connections ?? [];
    rows.innerHTML = (connections.length ? connections.map(item => {
      const here = item.projectId && item.projectId === this.snapshot()?.project.id;
      return `<article class="connection-row"><header><span class="connection-dot ${item.status}"></span><strong>${html(item.modelName || item.clientName)}</strong><span>${item.status === 'connected' ? '已连接' : '已断开'}</span></header><dl><dt>客户端</dt><dd>${html(item.clientName)} ${html(item.clientVersion)}</dd><dt>模型</dt><dd>${html(item.modelName || '客户端未提供模型名称')}${item.modelName ? ` <small>（${item.modelSource === 'configured' ? '连接配置' : '客户端自报'}）</small>` : ''}</dd><dt>项目访问</dt><dd>${here ? `最近访问：${html(this.snapshot()!.project.name)}` : item.projectId ? '最近访问其他项目' : '尚未访问项目'}</dd><dt>最近活动</dt><dd>${item.lastActivityAt ? html(new Date(item.lastActivityAt).toLocaleString()) : '尚未调用项目工具'}</dd></dl></article>`;
    }).join('') : '<div class="connection-empty"><strong>尚未连接 LLM</strong><p>可以先手工整理策划，或展开下面的说明接入客户端。</p></div>') + `<p class="connection-explanation">“已连接”表示 MCP 通道在线，不代表模型正在生成内容。异常断开约 ${Math.round((this.data?.heartbeatTimeoutMs ?? 35000) / 1000)} 秒后判定，页面每 4 秒刷新；模型名称来自连接配置或客户端报告。</p>`;
  }
  dispose() { clearInterval(this.timer); document.removeEventListener('visibilitychange', this.visible); this.dialog.remove(); }
}
