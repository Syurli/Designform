import { readLegacyWorkspace } from './platform.ts';
import { optionalBytes, resolveInside, writeBytes, ProjectError } from './files.ts';
import type { WorkspaceItem, WorkspaceState } from '../shared/model.ts';

/** 整理记录与正文隔离；两种发行版共用 JSON，调用方持有项目锁后更新。 */
export async function workspace(root: string, update?: { baseRevision: number; item?: WorkspaceItem; remove?: string }): Promise<WorkspaceState> {
  const saved = await optionalBytes(root, '.cewen/workspace.json');
  let state: WorkspaceState = { revision: 0, items: [] };
  if (saved) {
    try { state = JSON.parse(saved.toString('utf8')); if (!Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items)) throw new Error(); }
    catch { throw new ProjectError('WORKSPACE_DAMAGED', '整理记录无法解析，已保留原文件，请从备份恢复 .cewen/workspace.json。'); }
  } else if (await optionalBytes(root, '.cewen/workspace.sqlite')) {
    state = await readLegacyWorkspace(await resolveInside(root, '.cewen/workspace.sqlite'));
    await writeBytes(root, '.cewen/workspace.json', JSON.stringify(state, null, 2));
  }
  if (!update) return state;
  if (update.baseRevision !== state.revision) throw new ProjectError('WORKSPACE_CONFLICT', '整理记录已由另一窗口更新，请重新打开面板后再操作。');
  if (update.item) {
    const item = update.item;
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(item.id) || !['collection', 'annotation', 'marker', 'view', 'proposal'].includes(item.kind) || !['project', 'personal'].includes(item.scope) || typeof item.title !== 'string' || typeof item.text !== 'string' || !Array.isArray(item.targets) || item.targets.some(target => typeof target !== 'string') || !Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string')) throw new ProjectError('INVALID_WORKSPACE_ITEM', '整理记录的内容或身份无效。');
    const seen = new Set([item.id]); let parent = item.parent;
    while (parent) { if (seen.has(parent)) throw new ProjectError('COLLECTION_CYCLE', '工作分组不能循环嵌套。'); seen.add(parent); const group = state.items.find(record => record.id === parent); if (!group || group.kind !== 'collection') throw new ProjectError('INVALID_PARENT', '父分组不存在。'); parent = group.parent; }
    const updated = { ...item, updatedAt: new Date().toISOString() }, index = state.items.findIndex(record => record.id === item.id);
    if (index < 0) state.items.push(updated); else state.items[index] = updated;
  } else if (update.remove) {
    // 删除分组仅解除归属，不连带删除批注或文档。
    state.items = state.items.filter(item => item.id !== update.remove).map(item => { if (item.parent !== update.remove) return item; const next = { ...item }; delete next.parent; return next; });
  }
  state.revision++;
  await writeBytes(root, '.cewen/workspace.json', JSON.stringify(state, null, 2));
  return state;
}
