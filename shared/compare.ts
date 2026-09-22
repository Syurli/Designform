import type { KnowledgeNode, ProjectSnapshot } from './model.ts';

/** 身份比较不依赖显示标题和数组顺序；同名的不同规则仍是独立对象。 */
export interface Change { id: string; title: string; kind: '新增' | '删除' | '修改' | '移动' | '状态' | '关系'; detail: string }
export interface RevisionDiff { nodes: Change[]; relations: Change[]; documents: Change[]; structural: boolean }
export function compareSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): RevisionDiff {
  const nodes: Change[] = [], relations: Change[] = [], documents: Change[] = [];
  const previous = new Map(before.nodes.map(node => [node.id, node]));
  const current = new Map(after.nodes.map(node => [node.id, node]));
  const add = (node: KnowledgeNode, kind: Change['kind'], detail: string) => nodes.push({ id: node.id, title: node.title, kind, detail });
  for (const node of after.nodes) {
    const old = previous.get(node.id);
    if (!old) { add(node, '新增', '这个版本新增了该条目。'); continue; }
    if (old.title !== node.title || JSON.stringify(old.content) !== JSON.stringify(node.content)) add(node, '修改', old.title === node.title ? '正文发生变化。' : `原名称：${old.title}`);
    if (old.group !== node.group) add(node, '移动', `${old.group} → ${node.group}`);
    if (old.status !== node.status) add(node, '状态', `${old.status} → ${node.status}`);
  }
  for (const node of before.nodes) if (!current.has(node.id)) add(node, '删除', '目标版本不再包含该条目。');
  const oldEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  for (const edge of after.edges) {
    const old = oldEdges.get(edge.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(edge)) relations.push({ id: edge.id, title: `${current.get(edge.source)?.title ?? edge.source} → ${current.get(edge.target)?.title ?? edge.target}`, kind: old ? '关系' : '新增', detail: edge.note });
  }
  const edgeIds = new Set(after.edges.map(edge => edge.id));
  for (const edge of before.edges) if (!edgeIds.has(edge.id)) relations.push({ id: edge.id, title: `${previous.get(edge.source)?.title ?? edge.source} → ${previous.get(edge.target)?.title ?? edge.target}`, kind: '删除', detail: edge.note });
  const oldDocs = new Map(before.documents.map(document => [document.id, document]));
  for (const document of after.documents) {
    const old = oldDocs.get(document.id);
    if (!old || old.hash !== document.hash || old.path !== document.path) documents.push({ id: document.id, title: document.title, kind: !old ? '新增' : old.path !== document.path ? '移动' : '修改', detail: document.path });
  }
  const docIds = new Set(after.documents.map(document => document.id));
  for (const document of before.documents) if (!docIds.has(document.id)) documents.push({ id: document.id, title: document.title, kind: '删除', detail: document.path });
  return { nodes, relations, documents, structural: nodes.some(change => change.kind === '新增' || change.kind === '删除' || change.kind === '移动') || relations.length > 0 };
}

/** 按行保留原文，超大文件退化为前后整段，避免差异界面阻塞。 */
export function lineDiff(before: string, after: string): { kind: 'same' | 'add' | 'remove'; text: string }[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 1_000_000) return [{ kind: 'remove', text: before }, { kind: 'add', text: after }];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const result: ReturnType<typeof lineDiff> = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'same', text: a[i++] }); j++; }
    else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) result.push({ kind: 'add', text: b[j++] });
    else result.push({ kind: 'remove', text: a[i++] });
  }
  return result;
}
