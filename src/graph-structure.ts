import type { KnowledgeData } from '../shared/model';

/** 仅供知识空间排版使用的展示树；不会回写公开分类、文档归属或正文关系。 */
export interface GraphHierarchy {
  parent: Map<string, string>;
  children: Map<string, string[]>;
  depth: Map<string, number>;
  roots: string[];
}

/** 完整结构先确定层级，再按可见集合绘图，筛选不会把深层分类提升为顶层。 */
export function buildGraphHierarchy(data: KnowledgeData, rootId: string | undefined, preferSections = false): GraphHierarchy {
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const parent = new Map<string, string>();
  const assign = (child: string, owner: string | undefined) => {
    if (!owner || !nodes.has(child) || !nodes.has(owner) || child === rootId || parent.has(child) || child === owner) return;
    // 每次接入都沿已有父链查环，任意深度均使用迭代，避免长链导致递归栈溢出。
    let cursor: string | undefined = owner;
    while (cursor && cursor !== child) cursor = parent.get(cursor);
    if (!cursor) parent.set(child, owner);
  };
  // 分类元数据在没有总纲、因而没有 catalog 边时仍然提供真实的分类层级。
  data.groups.forEach(group => assign(group.id, group.parent ?? rootId));
  const priority = (kind: string | undefined, target: string) => preferSections
    ? kind === 'section' ? 0 : kind === 'catalog' ? 1 : kind === 'classification' ? 2 : 3
    : kind === 'classification' && nodes.get(target)?.kind === 'rule' ? 0 : kind === 'catalog' ? 1 : kind === 'section' ? 2 : 3;
  data.edges.filter(edge => edge.type === 'contains')
    .sort((first, second) => priority(first.origin?.kind, first.target) - priority(second.origin?.kind, second.target))
    .forEach(edge => assign(edge.target, edge.source));
  // 不完整旧资料依然可阅读；补充展示父项只使用已有身份，不伪造公开节点。
  data.nodes.forEach(node => assign(node.id, node.kind === 'rule' ? node.documentId : node.kind === 'document' ? node.group : undefined));
  const children = new Map(data.nodes.map(node => [node.id, [] as string[]]));
  // 以公开节点顺序保留同级排序，父边来源的优先级不会改变兄弟顺序。
  data.nodes.forEach(node => { const owner = parent.get(node.id); if (owner) children.get(owner)!.push(node.id); });
  const roots = data.nodes.filter(node => !parent.has(node.id)).map(node => node.id);
  if (rootId && roots.includes(rootId)) roots.splice(roots.indexOf(rootId), 1), roots.unshift(rootId);
  const depth = new Map<string, number>();
  const queue = roots.map(id => ({ id, level: id === rootId ? 0 : 1 }));
  for (let index = 0; index < queue.length; index++) {
    const { id, level } = queue[index];
    depth.set(id, level);
    for (const child of children.get(id) ?? []) queue.push({ id: child, level: level + 1 });
  }
  return { parent, children, depth, roots };
}

/** 弹性牵引同时遵守分类归属与文档包含；单独归类的小节仍可跟随原文档拖动。 */
export function graphContainment(data: KnowledgeData, rootId: string | undefined): Map<string, string[]> {
  const hierarchy = buildGraphHierarchy(data, rootId);
  const children = new Map([...hierarchy.children].map(([id, entries]) => [id, new Set(entries)]));
  data.edges.forEach(edge => {
    if (edge.type === 'contains' && edge.source !== edge.target && edge.target !== rootId && children.has(edge.source) && children.has(edge.target)) children.get(edge.source)!.add(edge.target);
  });
  return new Map([...children].map(([id, entries]) => [id, [...entries]]));
}
