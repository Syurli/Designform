import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LocalClient } from './client.ts';

/** 只有完成 MCP 初始化的客户端才报告在线；启动适配器进程本身不算连接。 */
export function createPresence(server: McpServer) {
  const client = new LocalClient(3500), id = randomUUID();
  let initialized = false, closed = false, projectId = '', pendingActivity = false;
  let modelName = (process.env.CEWEN_LLM_NAME ?? '').trim().slice(0, 120);
  let modelSource: 'configured' | 'reported' | 'unknown' = modelName ? 'configured' : 'unknown';
  let timer: ReturnType<typeof setInterval> | undefined, flight: Promise<boolean> | undefined;
  const heartbeat = () => {
    if (!initialized || closed || flight) return flight ?? Promise.resolve(false);
    const peer = server.server.getClientVersion(); if (!peer) return Promise.resolve(false);
    const activity = pendingActivity; pendingActivity = false;
    flight = client.request('/api/connections', { action: 'heartbeat', id, clientName: peer.name, clientVersion: peer.version, modelName, modelSource, projectId, activity }).then(() => true, () => { pendingActivity ||= activity; return false; }).finally(() => { flight = undefined; });
    return flight;
  };
  server.server.oninitialized = () => { initialized = true; void heartbeat(); timer = setInterval(() => { void heartbeat(); }, 10000); timer.unref(); };
  const disconnect = async () => {
    if (closed) return; closed = true; clearInterval(timer); await flight;
    if (initialized) await client.request('/api/connections', { action: 'disconnect', id }).catch(() => {});
  };
  const previousClose = server.server.onclose;
  server.server.onclose = () => { previousClose?.(); void disconnect(); };
  // 管道正常关闭时结束适配器；异常强制终止由服务端心跳超时反映。
  process.stdin.once('end', () => { void disconnect().finally(() => server.close()); });
  process.once('SIGTERM', () => { void disconnect().finally(() => server.close()); });
  process.once('SIGINT', () => { void disconnect().finally(() => server.close()); });
  return {
    // 当前适配器连接身份只用于服务端租约，不让模型自行指定其他客户端。
    id,
    /** 任务调用前等待真实心跳登记；首次初始化心跳仍在途中时再登记当前项目。 */
    async ensure(route: string) {
      if (!initialized || closed) throw new Error('MCP 尚未完成初始化或连接已关闭。');
      await flight;
      projectId = /^\/api\/projects\/([A-Za-z0-9_-]+)/.exec(route)?.[1] ?? projectId;
      pendingActivity = true;
      if (!await heartbeat()) throw new Error('无法登记策问连接心跳，请确认本机 MCP 服务正在运行后重试。');
    },
    activity(route: string) { projectId = /^\/api\/projects\/([A-Za-z0-9_-]+)/.exec(route)?.[1] ?? projectId; pendingActivity = true; void heartbeat(); },
    async identify(name: string) { modelName = name.trim().slice(0,120); modelSource = modelName ? 'reported' : 'unknown'; pendingActivity = true; await flight; await heartbeat(); return { modelName, modelSource }; },
  };
}
