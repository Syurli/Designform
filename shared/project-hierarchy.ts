import { HIERARCHY_MAX_DEPTH, type FileChange, type KnowledgeData, type KnowledgeGroup, type ProjectDocument, type ProjectSnapshot } from './model.ts';
import { readHeader } from './markdown.ts';
import { setMetadata } from './editing.ts';

/** 目录操作只传语义位置；坐标拖动本身不改变公开层级。 */
export type HierarchyMove = { kind: 'group' | 'document'; id: string; targetId: string; placement: 'before' | 'after' | 'inside' };
export type HierarchyParent = { kind: 'document' | 'group' | 'root'; id: string };

/** 总纲是唯一根；旧快照没有显式字段时仍按已解析的 GDD 节点读取。 */
export function getRootDocumentId(data: Pick<KnowledgeData, 'rootDocumentId' | 'nodes'>): string | undefined {
  return data.rootDocumentId ?? data.nodes.find(node => node.kind === 'document' && node.documentType === 'gdd')?.id;
}

/** 返回从顶层到直接父分类的链，不包含总纲，也不包含自身。 */
export function groupAncestors(data: Pick<KnowledgeData, 'groups'>, id: string): KnowledgeGroup[] {
  const byId = new Map(data.groups.map(group => [group.id, group]));
  const seen = new Set([id]), result: KnowledgeGroup[] = [];
  let parent = byId.get(id)?.parent;
  while (parent) { if (seen.has(parent)) break; seen.add(parent); const group = byId.get(parent); if (!group) break; result.unshift(group); parent = group.parent; }
  return result;
}

/** 返回从顶层到直接父文档的链，不包含总纲，也不包含自身。 */
export function documentAncestors(data: Pick<ProjectSnapshot, 'documents'>, id: string): ProjectDocument[] {
  const byId = new Map(data.documents.map(document => [document.id, document]));
  const seen = new Set([id]), result: ProjectDocument[] = [];
  let parent = byId.get(id)?.parent;
  while (parent) { if (seen.has(parent)) break; seen.add(parent); const document = byId.get(parent); if (!document || document.type === 'gdd') break; result.unshift(document); parent = document.parent; }
  return result;
}

/** 直属 DD 归分类，子 DD 归父文档；总纲本身没有父项。 */
export function effectiveDocumentParent(data: Pick<ProjectSnapshot, 'documents' | 'rootDocumentId' | 'nodes'>, id: string): HierarchyParent | undefined {
  const document = data.documents.find(item => item.id === id);
  if (!document || document.type === 'gdd' || id === getRootDocumentId(data)) return undefined;
  return document.parent ? { kind: 'document', id: document.parent } : { kind: 'group', id: document.system || 'system-unassigned' };
}

function orderMap(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, row]) => typeof key !== 'string' || !Array.isArray(row) || row.some(id => typeof id !== 'string'))) throw new Error('PROJECT.md 的 documentOrder 格式无效，请先修正。');
  return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, [...row as string[]]]));
}

/** 所有层级均从总纲以下计数；移动时按结果树核对，不凭单个目标猜深度。 */
function assertDepth(groups: KnowledgeGroup[], documents: ProjectDocument[], rootId?: string) {
  const groupById = new Map(groups.map(group => [group.id, group]));
  const docById = new Map(documents.map(document => [document.id, document]));
  const groupDepth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) throw new Error('分类层级形成循环。'); seen.add(id);
    const group = groupById.get(id); if (!group) throw new Error('分类层级引用了不存在的分类。');
    return 1 + (group.parent ? groupDepth(group.parent, seen) : 0);
  };
  for (const group of groups) if (groupDepth(group.id) > HIERARCHY_MAX_DEPTH) throw new Error(`分类超过总纲以下 ${HIERARCHY_MAX_DEPTH} 层。`);
  const docDepth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) throw new Error('文档层级形成循环。'); seen.add(id);
    const document = docById.get(id); if (!document) throw new Error('父文档不存在。');
    if (document.type === 'gdd' || id === rootId) return 0;
    return 1 + (document.parent ? docDepth(document.parent, seen) : document.system && groupById.has(document.system) ? groupDepth(document.system) : 0);
  };
  for (const document of documents) if (docDepth(document.id) > HIERARCHY_MAX_DEPTH) throw new Error(`文档超过总纲以下 ${HIERARCHY_MAX_DEPTH} 层。`);
}

/** 生成一次原子公开批次；正文、别名和手工关系原样保留。 */
export function moveHierarchy(snapshot: ProjectSnapshot, move: HierarchyMove): { changes: FileChange[]; label: string } {
  if (snapshot.historical) throw new Error('历史版本只读，请回到最新工作稿。');
  if (!snapshot.projectEntry) throw new Error('缺少 PROJECT.md 修改基准。');
  const rootId = getRootDocumentId(snapshot), groups = snapshot.groups.filter(group => group.id !== 'system-unassigned').map(group => ({ ...group }));
  const documents = snapshot.documents.filter(document => document.type !== 'guide').map(document => ({ ...document }));
  const projectMetadata = readHeader(snapshot.projectEntry.text).metadata;
  const changes = new Map<string, FileChange>();
  const stage = (path: string, baseHash: string, original: string, text: string) => { if (text !== original) changes.set(path, { path, baseHash, text }); };
  const groupById = new Map(groups.map(group => [group.id, group]));
  const docById = new Map(documents.map(document => [document.id, document]));

  if (move.kind === 'group') {
    const group = groupById.get(move.id); if (!group) throw new Error('待移动分类不存在。');
    if (move.id === move.targetId) throw new Error('分类不能相对自身移动。');
    const targetGroup = groupById.get(move.targetId);
    if (move.placement !== 'inside' && !targetGroup) throw new Error('分类前移或后移必须选择另一个分类。');
    if (move.placement === 'inside' && !targetGroup && move.targetId !== rootId) throw new Error('顶层分类只能放入项目总纲。');
    const parent = move.placement === 'inside' ? targetGroup?.id : targetGroup?.parent;
    if (parent === group.id || parent && groupAncestors({ groups }, parent).some(item => item.id === group.id)) throw new Error('分类不能移入自身或下级分类。');
    group.parent = parent;
    assertDepth(groups, documents, rootId);
    const source = Array.isArray(projectMetadata.systems) ? projectMetadata.systems : (() => { const root = snapshot.documents.find(item => item.id === rootId); return root && Array.isArray(readHeader(root.text).metadata.systems) ? readHeader(root.text).metadata.systems : groups; })();
    const rows = (source as Record<string, unknown>[]).map(raw => ({ ...raw }));
    const at = rows.findIndex(row => row.id === group.id);
    if (at < 0) throw new Error('公开分类目录缺少待移动分类。');
    const [row] = rows.splice(at, 1); if (parent) row.parent = parent; else delete row.parent;
    let insert = rows.length;
    if (targetGroup && move.placement !== 'inside') { insert = rows.findIndex(item => item.id === targetGroup.id) + (move.placement === 'after' ? 1 : 0); }
    rows.splice(insert, 0, row);
    const nextProject = setMetadata(snapshot.projectEntry.text, { systems: rows, minimumAppVersion: '0.7.0' });
    stage('PROJECT.md', snapshot.projectEntry.hash, snapshot.projectEntry.text, nextProject);
    if (!Array.isArray(projectMetadata.systems)) {
      const root = snapshot.documents.find(item => item.id === rootId);
      if (root && Array.isArray(readHeader(root.text).metadata.systems)) stage(root.path, root.hash, root.text, setMetadata(root.text, { systems: '' }));
    }
    return { changes: [...changes.values()], label: `调整分类层级：${group.label}` };
  }

  const document = docById.get(move.id);
  if (!document || document.type === 'gdd' || document.id === rootId) throw new Error('只能移动专项文档，项目总纲不能移动。');
  const targetDoc = docById.get(move.targetId), targetGroup = groupById.get(move.targetId);
  if (move.placement === 'inside' && !targetDoc && !targetGroup && move.targetId !== 'system-unassigned') throw new Error('文档只能移入分类或另一份专项文档。');
  if (move.placement !== 'inside' && (!targetDoc || targetDoc.type === 'gdd')) throw new Error('文档前移或后移必须选择同级文档。');
  if (targetDoc?.id === document.id) throw new Error('文档不能相对自身移动。');
  let parent: string | undefined, system: string;
  if (move.placement === 'inside') {
    if (targetDoc?.type === 'gdd') throw new Error('专项文档必须先归入分类，不能直接挂总纲。');
    parent = targetDoc?.id; system = targetDoc?.system ?? (targetGroup?.id ?? '');
  } else { parent = targetDoc!.parent; system = targetDoc!.system; }
  if (parent === document.id || parent && documentAncestors({ documents }, parent).some(item => item.id === document.id)) throw new Error('文档不能移入自身或下级文档。');
  document.parent = parent; document.system = system;
  const descendants = new Set([document.id]);
  let expanded = true;
  while (expanded) { expanded = false; for (const child of documents) if (child.parent && descendants.has(child.parent) && !descendants.has(child.id)) { descendants.add(child.id); expanded = true; } }
  for (const child of documents) if (descendants.has(child.id)) child.system = system;
  assertDepth(groups, documents, rootId);
  for (const child of documents) if (descendants.has(child.id)) {
    const source = snapshot.documents.find(item => item.id === child.id)!;
    stage(source.path, source.hash, source.text, setMetadata(source.text, { system, ...(child.id === document.id ? { parent: parent ?? '' } : {}) }));
  }
  const order = orderMap(projectMetadata.documentOrder);
  for (const list of Object.values(order)) { const at = list.indexOf(document.id); if (at >= 0) list.splice(at, 1); }
  const key = parent ? `document:${parent}` : system || 'system-unassigned';
  const siblings = documents.filter(item => item.id !== document.id && (item.parent ?? '') === (parent ?? '') && item.system === system).map(item => item.id);
  const list = [...new Set([...(order[key] ?? []).filter(id => siblings.includes(id)), ...siblings])];
  let at = list.length;
  if (targetDoc && move.placement !== 'inside') { const targetAt = list.indexOf(targetDoc.id); at = targetAt >= 0 ? targetAt + (move.placement === 'after' ? 1 : 0) : list.length; }
  list.splice(at, 0, document.id); order[key] = list;
  stage('PROJECT.md', snapshot.projectEntry.hash, snapshot.projectEntry.text, setMetadata(snapshot.projectEntry.text, { documentOrder: order, minimumAppVersion: '0.7.0' }));
  return { changes: [...changes.values()], label: `调整文档层级：${document.title}` };
}
