import type { LlmConnection, LlmConnectionState } from './model.ts';

/** MCP 心跳对应独立会话；客户端名称相同不能证明来自同一个桌面实例。 */
export function onlineConnections(state?: LlmConnectionState) {
  return state?.connections.filter(item => item.status === 'connected') ?? [];
}

/** 顶栏先选当前项目的会话，再选任意在线会话；项目访问不是连接成立的条件。 */
export function preferredConnection(state?: LlmConnectionState, projectId?: string) {
  const connected = onlineConnections(state);
  return (projectId ? connected.find(item => item.projectId === projectId) : undefined) ?? connected[0];
}

/** 所有开场白入口统一按会话计数，避免把一个 Codex 的多个 MCP 会话称作多个客户端。 */
export function connectionSessionLabel(state?: LlmConnectionState) {
  if (!state) return '连接状态暂不可用';
  const count = onlineConnections(state).length;
  return count ? `MCP 已连接 · ${count} 个在线会话` : '未连接 MCP';
}

/** 分组仅用于界面展示，原始会话身份仍保留给心跳、并发任务和工作锁。 */
export interface ConnectionDisplayGroup {
  representative: LlmConnection;
  sessions: LlmConnection[];
  lastActivityAt?: string;
}

/** 相同名称、版本、模型来源及在线状态合并成卡片，不把断开记录计入在线数量。 */
export function connectionDisplayGroups(state?: LlmConnectionState): ConnectionDisplayGroup[] {
  const groups = new Map<string, ConnectionDisplayGroup>();
  for (const item of state?.connections ?? []) {
    const key = JSON.stringify([item.clientName, item.clientVersion, item.modelName, item.modelSource, item.status]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { representative: item, sessions: [item], lastActivityAt: item.lastActivityAt });
      continue;
    }
    group.sessions.push(item);
    if (item.lastSeenAt > group.representative.lastSeenAt) group.representative = item;
    if (item.lastActivityAt && (!group.lastActivityAt || item.lastActivityAt > group.lastActivityAt)) group.lastActivityAt = item.lastActivityAt;
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.representative.status === 'connected') - Number(a.representative.status === 'connected') ||
    b.representative.lastSeenAt.localeCompare(a.representative.lastSeenAt));
}
