import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** CLI 与 MCP 都通过正在运行的服务，不直接打开数据库或形成第二个写入者。 */
export class LocalClient {
  private url = '';
  private token = '';
  /** 状态心跳使用短超时；普通文档操作仍允许完整导入等较长任务。 */
  constructor(private timeoutMs?: number) {}
  async connect() {
    let configured = process.env.CEWEN_URL;
    if (!configured) {
      const home = process.env.CEWEN_HOME ?? path.join(os.homedir(), 'Documents', '策问工作区');
      try { configured = JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8')).url; }
      catch { configured = 'http://127.0.0.1:5173'; }
    }
    const url = new URL(configured!);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password) throw new Error('CEWEN_URL 必须是本机策问服务地址。');
    this.url = url.origin;
    const response = await fetch(`${this.url}/api/session`, { signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined }), result = await response.json() as { token?: string; error?: { message: string }; protocolVersion: number };
    if (!response.ok || !result.token || result.protocolVersion !== 1) throw new Error(result?.error?.message ?? '策问服务版本不匹配或尚未启动。');
    this.token = result.token;
  }
  async request<T = unknown>(route: string, input?: unknown, retry = true): Promise<T> {
    if (!this.token) await this.connect();
    if (!route.startsWith('/api/')) throw new Error('只支持策问公开接口。');
    const response = await fetch(this.url + route, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Cewen-Session': this.token }, signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const result = await response.json() as { error?: { code: string; message: string; details?: unknown } };
    if (result?.error?.code === 'SESSION_REQUIRED' && retry) { await this.connect(); return this.request<T>(route, input, false); }
    if (!response.ok || result?.error) throw new Error(JSON.stringify(result?.error ?? { code: 'REQUEST_FAILED', message: '本地服务未完成请求。' }));
    return result as T;
  }
}
