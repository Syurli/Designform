import * as THREE from 'three';
import type { KnowledgeData, KnowledgeEdge } from './data';
import type { GraphDirection } from './graph-hierarchy';

/** 系统分层沿分类分栏、沿分支连续阅读；脑图仍使用独立的树形排布。 */
export function layersLayout(data: KnowledgeData, rootId: string | undefined, direction: GraphDirection, visibleIds: Set<string>, parentOutput: Map<string, string>): Map<string, THREE.Vector3> {
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const parent = new Map<string, string>();
  // 单独归类的小节在所属系统中展示，其余小节紧跟原文档；不修改公开包含关系。
  const priority = (edge: KnowledgeEdge) => edge.origin?.kind === 'classification' && nodes.get(edge.target)?.kind === 'rule'
    ? 0 : edge.origin?.kind === 'catalog' ? 1 : edge.origin?.kind === 'section' ? 2 : 3;
  const edges = data.edges.filter(edge => edge.type === 'contains' && nodes.has(edge.source) && nodes.has(edge.target) && edge.source !== edge.target)
    .sort((first, second) => priority(first) - priority(second));
  for (const edge of edges) {
    if (parent.has(edge.target) || edge.target === rootId) continue;
    let owner: string | undefined = edge.source;
    while (owner && owner !== edge.target) owner = parent.get(owner);
    if (!owner) parent.set(edge.target, edge.source);
  }
  parentOutput.clear();
  parent.forEach((owner, child) => parentOutput.set(child, owner));

  // 先构建完整分支，再裁掉不可见条目；筛选不会让子项随机落入其他分类。
  const children = new Map<string, string[]>();
  data.nodes.forEach(node => children.set(node.id, []));
  parent.forEach((owner, child) => children.get(owner)!.push(child));
  const order = new Map(data.nodes.map((node, index) => [node.id, index]));
  children.forEach(entries => entries.sort((first, second) => order.get(first)! - order.get(second)!));
  type Entry = { id: string; depth: number };
  const collect = (id: string, depth: number, entries: Entry[]) => {
    const visible = visibleIds.has(id);
    if (visible) entries.push({ id, depth });
    for (const child of children.get(id) ?? []) collect(child, depth + Number(visible), entries);
  };
  const branches = [...(children.get(rootId ?? '') ?? []), ...data.nodes.filter(node => node.id !== rootId && !parent.has(node.id)).map(node => node.id)];
  const lanes: Entry[][] = [];
  const ungrouped: Entry[] = [];
  for (const id of branches) {
    const entries: Entry[] = [];
    collect(id, 0, entries);
    if (!entries.length) continue;
    // 总纲直属正文与无归属条目共用末栏，不为每个章节另开一列，也不伪造分类节点。
    if (nodes.get(id)?.kind === 'system') lanes.push(entries);
    else ungrouped.push(...entries);
  }
  if (ungrouped.length) lanes.push(ungrouped);

  const vertical = direction === 'vertical';
  const indent = 24;
  // 为标签保留整列宽度；纵向按实际标题估算，横向按最深缩进分配行高。
  const spans = lanes.map(entries => vertical ? Math.max(200, ...entries.map(entry => {
    const titleWidth = Math.min(190, [...nodes.get(entry.id)!.title].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 13 : 7), 14));
    return entry.depth * indent + titleWidth / .72 + 40;
  })) : 108 + Math.max(...entries.map(entry => entry.depth)) * indent);
  const result = new Map<string, THREE.Vector3>();
  if (rootId && visibleIds.has(rootId)) result.set(rootId, new THREE.Vector3());
  let cross = -spans.reduce((sum, span) => sum + span, 0) / 2;
  lanes.forEach((entries, laneIndex) => {
    let forward = nodes.get(entries[0].id)?.kind === 'system' ? vertical ? 130 : 210 : vertical ? 212 : 260;
    entries.forEach((entry, index) => {
      // 分支内使用前序顺序；返回同级文档或子分类时增加留白，章节不会散到另一列。
      if (index) forward += vertical ? nodes.get(entry.id)?.kind === 'rule' ? 54 : 82 : 250;
      const across = cross + entry.depth * indent;
      result.set(entry.id, vertical ? new THREE.Vector3(across, -forward, 0) : new THREE.Vector3(forward, -across, 0));
    });
    cross += spans[laneIndex];
  });
  // 每栏标签沿节点右侧展开，因此总纲按完整栏宽居中，不按节点圆点的中点居中。
  return result;
}
