import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 连接诊断只保留接口类别与时长，不携带凭证、查询参数、项目身份或请求正文。 */
export interface ConnectionDiagnostic {
  stage: 'session' | 'request';
  route: string;
  elapsedMs: number;
  code: string;
  httpStatus?: number;
  timeoutMs?: number;
}

/** 将真实失败阶段带给调用方，避免把握手超时误报为服务未启动。 */
export class LocalClientError extends Error {
  constructor(message: string, readonly diagnostic: ConnectionDiagnostic) {
    super(`${message}（${diagnostic.stage === 'session' ? '会话握手' : '接口请求'} ${diagnostic.route}，${diagnostic.elapsedMs}ms，${diagnostic.code}${diagnostic.httpStatus ? `，HTTP ${diagnostic.httpStatus}` : ''}${diagnostic.timeoutMs ? `，时限 ${diagnostic.timeoutMs}ms` : ''}）`);
  }
}

/** CLI 与 MCP 都通过正在运行的服务，不直接打开数据库或形成第二个写入者。 */
export class LocalClient {
  private url = '';
  private token = '';
  private connecting?: Promise<void>;
  /** 握手和业务请求使用独立预算；未指定业务时限时保留长文档操作能力。 */
  constructor(private options: { sessionTimeoutMs?: number; requestTimeoutMs?: number } = {}) {}

  /** 并发工具共用一次握手；失败后清理状态，下次调用重新读取服务地址。 */
  async connect() {
    if (this.connecting) return this.connecting;
    this.token = '';
    const connecting = this.openSession();
    this.connecting = connecting;
    try { await connecting; }
    finally { if (this.connecting === connecting) this.connecting = undefined; }
  }

  private async openSession() {
    let configured = process.env.CEWEN_URL;
    if (!configured) {
      const home = process.env.CEWEN_HOME ?? path.join(os.homedir(), 'Documents', '策问工作区');
      try { configured = JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8')).url; }
      catch { configured = 'http://127.0.0.1:5173'; }
    }
    const url = new URL(configured!);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password) throw new Error('CEWEN_URL 必须是本机策问服务地址。');
    this.url = url.origin;
    // MCP/CLI 只需要凭证；不让项目库刷新或历史检查成为连接握手的前置条件。
    const { result, elapsedMs } = await this.exchange<{ token?: string; protocolVersion?: number }>('/api/session?handshake=1', undefined, 'session', this.options.sessionTimeoutMs ?? 20000);
    if (!result?.token || result.protocolVersion !== 1) throw new LocalClientError('策问握手响应的凭证或协议版本无效。', { stage: 'session', route: '/api/session', elapsedMs, code: 'PROTOCOL_MISMATCH' });
    this.token = result.token;
  }

  /** 只自动重试服务明确拒绝执行的过期会话；超时不能推断写入没有发生。 */
  async request<T = unknown>(route: string, input?: unknown, retry = true): Promise<T> {
    if (!route.startsWith('/api/')) throw new Error('只支持策问公开接口。');
    if (!this.token) await this.connect();
    try { return (await this.exchange<T>(route, input, 'request', this.options.requestTimeoutMs)).result; }
    catch (error) {
      if (error instanceof LocalClientError) {
        // 网络中断后让下次请求重读 connection.json，适配重启后可能变化的端口。
        if (['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SESSION_REQUIRED'].includes(error.diagnostic.code)) this.token = '';
        if (error.diagnostic.code === 'SESSION_REQUIRED' && retry) { await this.connect(); return this.request<T>(route, input, false); }
      }
      throw error;
    }
  }

  /** 捕获网络、响应体和 HTTP 失败，统一保留脱敏路径及真实耗时。 */
  private async exchange<T>(route: string, input: unknown, stage: ConnectionDiagnostic['stage'], timeoutMs?: number) {
    const started = performance.now(), safeRoute = route.split('?')[0].replace(/^(\/api\/projects)\/[^/]+/, '$1/:project');
    let httpStatus: number | undefined;
    const diagnostic = (code: string): ConnectionDiagnostic => ({ stage, route: safeRoute, elapsedMs: Math.round(performance.now() - started), code, ...(httpStatus ? { httpStatus } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    try {
      const response = await fetch(this.url + route, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(stage === 'request' ? { 'X-Cewen-Session': this.token } : {}) }, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      httpStatus = response.status;
      const result = await response.json() as T & { error?: { code?: string; message?: string; details?: unknown } };
      // 冲突详情仍交给发起工具的调用方；后台日志只使用 diagnostic 的脱敏字段。
      if (!response.ok || result?.error) throw new LocalClientError(result?.error ? JSON.stringify(result.error) : '本地服务未完成请求。', diagnostic(result?.error?.code ?? 'HTTP_ERROR'));
      return { result, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      if (error instanceof LocalClientError) throw error;
      const name = error instanceof Error ? error.name : '', cause = (error as { cause?: { code?: string } })?.cause?.code;
      if (name === 'TimeoutError' || name === 'AbortError') throw new LocalClientError(stage === 'session' ? '策问会话握手超时，服务可能正在启动或忙碌，请稍后重试。' : '策问接口响应超时，请稍后重试；写入结果需要重新读取确认。', diagnostic('REQUEST_TIMEOUT'));
      if (httpStatus) throw new LocalClientError('策问服务返回了无法解析的响应。', diagnostic('INVALID_RESPONSE'));
      throw new LocalClientError(cause === 'ECONNREFUSED' ? '策问服务地址拒绝连接，请确认服务已启动。' : '无法连接策问本机服务，请检查启动状态后重试。', diagnostic('NETWORK_ERROR'));
    }
  }
}
