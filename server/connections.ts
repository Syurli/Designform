import { performance } from 'node:perf_hooks';
import type { LlmConnection, LlmConnectionState } from '../shared/model.ts';
import { ProjectError } from './files.ts';

/** 临时连接表使用单调时钟判定超时，系统时间调整不会把断开的客户端判成在线。 */
export class ConnectionRegistry {
  private entries = new Map<string, { info: LlmConnection; seen: number; closed: boolean }>();
  private readonly timeout = 35000;
  read(): LlmConnectionState {
    const now = performance.now();
    for (const [id, value] of this.entries) if (now - value.seen > 15 * 60 * 1000) this.entries.delete(id);
    return { heartbeatTimeoutMs: this.timeout, connections: [...this.entries.values()].map(value => ({ ...value.info, status: value.closed || now - value.seen > this.timeout ? 'disconnected' as const : 'connected' as const })).sort((a,b) => Number(b.status === 'connected') - Number(a.status === 'connected') || b.lastSeenAt.localeCompare(a.lastSeenAt)) };
  }
  update(input: Record<string, unknown>) {
    const text = (key: string, max = 120) => typeof input[key] === 'string' ? input[key].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
    const id = text('id'); if (!/^[A-Za-z0-9_-]{12,120}$/.test(id)) throw new ProjectError('INVALID_CONNECTION', '连接身份无效。');
    const old = this.entries.get(id);
    if (input.action === 'disconnect') { if (old) { old.closed = true; old.seen = performance.now(); } return this.read(); }
    if (input.action !== 'heartbeat') throw new ProjectError('INVALID_CONNECTION', '不支持的连接操作。');
    const clientName = text('clientName'); if (!clientName) throw new ProjectError('INVALID_CONNECTION', '连接需要 MCP 客户端名称。');
    this.read();
    if (!old && this.entries.size >= 32) { const offline = [...this.entries].find(([,value]) => value.closed || performance.now() - value.seen > this.timeout); if (offline) this.entries.delete(offline[0]); else throw new ProjectError('CONNECTION_LIMIT', '同时连接数已达上限。'); }
    const now = new Date().toISOString(), modelName = text('modelName'), projectId = text('projectId');
    if (projectId && !/^[A-Za-z0-9_-]+$/.test(projectId)) throw new ProjectError('INVALID_CONNECTION', '连接的项目身份无效。');
    const info: LlmConnection = { id, transport: 'mcp', clientName, clientVersion: text('clientVersion', 50), modelName, modelSource: modelName && (input.modelSource === 'configured' || input.modelSource === 'reported') ? input.modelSource : 'unknown', connectedAt: old && !old.closed ? old.info.connectedAt : now, lastSeenAt: now, lastActivityAt: input.activity === true ? now : old?.info.lastActivityAt, projectId: projectId || old?.info.projectId, status: 'connected' };
    this.entries.set(id, { info, seen: performance.now(), closed: false }); return this.read();
  }
}
