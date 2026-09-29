import * as THREE from 'three';
import type { KnowledgeData } from './data';
import type { GraphDirection } from './graph-hierarchy';
import { buildGraphHierarchy } from './graph-structure';

/** 分类按真实层级并列；每个分类独占内容列，文档及小节按公开顺序连续阅读。 */
export function layersLayout(data: KnowledgeData, rootId: string | undefined, direction: GraphDirection, visibleIds: Set<string>, parentOutput: Map<string, string>): Map<string, THREE.Vector3> {
  const hierarchy = buildGraphHierarchy(data, rootId);
  parentOutput.clear();
  hierarchy.parent.forEach((owner, child) => parentOutput.set(child, owner));
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  type Entry = { id: string; depth: number };
  type Lane = { category?: string; parentCategory?: string; categoryDepth: number; lastCategoryDepth: number; active: boolean; entries: Entry[] };
  const lanes: Lane[] = [];
  const byCategory = new Map<string, Lane>();
  // 总纲直属小节与无归属资料共用末列，不为每份文档伪造分类，也不与分类内容列抢位置。
  const ungrouped: Lane = { categoryDepth: 0, lastCategoryDepth: 0, active: false, entries: [] };
  type Visit = { id: string; category?: string; categoryDepth: number; contentDepth: number };
  const stack: Visit[] = [...hierarchy.roots].reverse().map(id => ({ id, categoryDepth: 0, contentDepth: 0 }));
  // 前序只控制内容顺序及缩进；分类层距单独计数，分类文档数量不会把子分类推到更深层。
  while (stack.length) {
    const visit = stack.pop()!, node = nodes.get(visit.id)!;
    let { category, categoryDepth, contentDepth } = visit;
    if (node.kind === 'system') {
      const parentCategory = category;
      category = node.id; categoryDepth++; contentDepth = 0;
      const lane: Lane = { category, parentCategory, categoryDepth, lastCategoryDepth: categoryDepth, active: visibleIds.has(category), entries: [] };
      byCategory.set(category, lane); lanes.push(lane);
    } else if (node.id !== rootId) {
      if (visibleIds.has(node.id)) (category ? byCategory.get(category)! : ungrouped).entries.push({ id: node.id, depth: contentDepth });
      contentDepth++;
    }
    // 隐藏父分类仍计入分类层数，隐藏父文档仍计入内容缩进；任意深度使用迭代而非递归。
    for (const id of [...(hierarchy.children.get(node.id) ?? [])].reverse()) stack.push({ id, category, categoryDepth, contentDepth });
  }
  // 自下向上记录实际展示的最深分类层；父分类的内容接在这条分类链之后，折线不穿过文档列。
  for (let index = lanes.length - 1; index >= 0; index--) {
    const lane = lanes[index];
    if (lane.entries.length) lane.active = true;
    if (lane.active && lane.parentCategory) {
      const owner = byCategory.get(lane.parentCategory)!;
      owner.lastCategoryDepth = Math.max(owner.lastCategoryDepth, lane.lastCategoryDepth);
      owner.active = true;
    }
  }
  const visibleLanes = lanes.filter(lane => visibleIds.has(lane.category!) || lane.entries.length);
  if (ungrouped.entries.length) visibleLanes.push(ungrouped);
  const vertical = direction === 'vertical';
  const indent = 24;
  const titleWidth = (id: string) => Math.min(240, [...nodes.get(id)!.title].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 13 : 7), 24));
  // 内容列彼此独占横向空间；父分类内容与下级分类链分列，即使前后坐标相近也不会重叠。
  const spans = visibleLanes.map(lane => vertical
    ? Math.max(220, lane.category ? titleWidth(lane.category) / .72 + 48 : 0, ...lane.entries.map(entry => entry.depth * indent + titleWidth(entry.id) / .72 + 48))
    : 118 + Math.max(0, ...lane.entries.map(entry => entry.depth)) * indent);
  const result = new Map<string, THREE.Vector3>();
  let cross = -spans.reduce((sum, span) => sum + span, 0) / 2;
  const place = (id: string, across: number, forward: number) => result.set(id, vertical ? new THREE.Vector3(across, -forward, 0) : new THREE.Vector3(forward, -across, 0));
  visibleLanes.forEach((lane, laneIndex) => {
    // 横向时标签位于节点上方，故同列跨度转为行高；纵向标签在节点右侧，保留左侧星点留白。
    const across = cross + (vertical ? 24 : 59);
    const categoryForward = lane.categoryDepth * (vertical ? 212 : 282);
    if (lane.category && visibleIds.has(lane.category)) place(lane.category, across, categoryForward);
    let forward = lane.category ? lane.lastCategoryDepth * (vertical ? 212 : 282) : vertical ? 130 : 10;
    lane.entries.forEach(entry => {
      // 父文档先出现，其小节及下级文档紧随其后；兄弟文档依次向下/向右，不并排铺开。
      forward += vertical ? nodes.get(entry.id)!.kind === 'rule' ? 54 : 82 : 250;
      // 无归属资料同样不得越过总纲之下的内容边界。
      forward = Math.max(forward, vertical ? 212 : 260);
      place(entry.id, across + entry.depth * indent, forward);
    });
    cross += spans[laneIndex];
  });
  // 总纲保持零点；只调整展示坐标，不修改公开分类身份、文档归属或包含关系。
  if (rootId && visibleIds.has(rootId)) result.set(rootId, new THREE.Vector3());
  return result;
}
