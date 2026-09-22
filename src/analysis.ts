import { nodes, edges, type KnowledgeNode, type KnowledgeEdge } from './data';

/** 焦点周围的阅读分区；分区表达核对顺序，不表示已经证明的因果传播。 */
export type AnalysisLane = 'upstream' | 'downstream' | 'context';

/** 三个分区在布局、卡片和辅助说明中共用同一套中文名称。 */
export const laneLabels: Record<AnalysisLane, string> = {
  upstream: '依赖与约束来源',
  downstream: '建议复核',
  context: '文档与相关问题',
};

/** 一个相邻节点只产生一张卡片，同节点之间的多条关系完整保留。 */
export interface AnalysisEntry {
  /** 相邻节点原始数据；辅助模块只读取，不修改其正文或状态。 */
  node: KnowledgeNode;
  /** 根据关系语义决定的阅读分区。 */
  lane: AnalysisLane;
  /** 与焦点直接相连的边在本次 allEdges 输入中的位置。 */
  edgeIndices: number[];
  /** 完整关系语句，以及不能归为单向关系时的说明。 */
  captions: string[];
}

/** 一跳分析结果，不自动继续追踪第二跳，也不生成游戏设计决定。 */
export interface AnalysisResult {
  /** 本轮关系阅读的焦点节点。 */
  focus: KnowledgeNode;
  /** 分区中的相邻节点，不重复包含焦点本身。 */
  entries: AnalysisEntry[];
  /** 焦点及有效相邻节点，可直接用于图谱可见性判断。 */
  visibleIds: Set<string>;
  /** 本轮直接关系的原始索引；不包含邻居之间额外存在的边。 */
  edgeIndices: number[];
}

/** 汇集同一相邻节点的各条关系，保留方向冲突供最后统一判断。 */
interface PendingEntry {
  node: KnowledgeNode;
  lanes: Set<AnalysisLane>;
  edgeIndices: number[];
  captions: string[];
}

/**
 * 将边转换为从源节点到目标节点的完整中文语义。
 * 数字参数是 allEdges 中的索引；传入边对象时同样使用 allNodes 查找标题。
 * 使用自定义数据时显式传入同一组节点与边，避免依赖全局样例的名称或索引。
 * 关联边的存储方向不代表因果，依赖边也不改写成“来源会影响目标”。
 */
export function edgeSentence(
  edgeOrIndex: number | KnowledgeEdge,
  allNodes: readonly KnowledgeNode[] = nodes,
  allEdges: readonly KnowledgeEdge[] = edges,
): string {
  const edge = typeof edgeOrIndex === 'number'
    ? (Number.isInteger(edgeOrIndex) ? allEdges[edgeOrIndex] : undefined)
    : edgeOrIndex;
  if (!edge) return '未找到这条关系。';

  const source = allNodes.find(node => node.id === edge.source)?.title ?? `未知节点（${edge.source}）`;
  const target = allNodes.find(node => node.id === edge.target)?.title ?? `未知节点（${edge.target}）`;

  switch (edge.type) {
    case 'contains':
      return `“${source}”包含“${target}”。`;
    case 'depends':
      return `“${source}”依赖“${target}”；箭头指向其依赖项。`;
    case 'constrains':
      return `“${source}”约束“${target}”。`;
    case 'relates':
      return `“${source}”与“${target}”相关；此联系不表示因果关系。`;
    case 'references':
      return `“${source}”引用“${target}”；引用本身不代表设计依赖。`;
    case 'replaces':
      return `“${source}”替代“${target}”；旧规则仍保留为历史依据。`;
    default:
      return `“${source}”与“${target}”的关系类型尚未识别。`;
  }
}

/**
 * 按焦点的一跳关系生成阅读分区：
 * - 焦点依赖另一节点，或另一节点约束焦点：依赖与约束来源。
 * - 另一节点依赖焦点，或焦点约束另一节点：建议复核，不能据此断言必须修改。
 * - 包含、相关或涉及未决问题的关系：文档与相关问题。
 * - 同一节点同时承担两个方向：放入上下文，明确保留双向说明。
 * 函数不修改输入；无效焦点返回 undefined，缺失端点的边不进入结果。
 */
export function buildAnalysis(
  focusId: string,
  allNodes: readonly KnowledgeNode[] = nodes,
  allEdges: readonly KnowledgeEdge[] = edges,
): AnalysisResult | undefined {
  const nodeById = new Map(allNodes.map(node => [node.id, node]));
  const focus = nodeById.get(focusId);
  if (!focus) return undefined;

  const pending = new Map<string, PendingEntry>();
  const visibleIds = new Set([focus.id]);
  const edgeIndices: number[] = [];

  allEdges.forEach((edge, index) => {
    const isSource = edge.source === focus.id;
    const isTarget = edge.target === focus.id;
    if (!isSource && !isTarget) return;

    const neighbor = nodeById.get(isSource ? edge.target : edge.source);
    if (!neighbor) return;

    // 自环仍保留为焦点的直接关系，但不把焦点复制成相邻卡片。
    edgeIndices.push(index);
    if (neighbor.id === focus.id) return;
    visibleIds.add(neighbor.id);

    let lane: AnalysisLane = 'context';
    const involvesQuestion = focus.status === 'question' || neighbor.status === 'question';
    if (!involvesQuestion) {
      if (edge.type === 'depends') lane = isSource ? 'upstream' : 'downstream';
      if (edge.type === 'constrains') lane = isSource ? 'downstream' : 'upstream';
    }

    const entry: PendingEntry = pending.get(neighbor.id) ?? {
      node: neighbor,
      lanes: new Set<AnalysisLane>(),
      edgeIndices: [],
      captions: [],
    };
    entry.lanes.add(lane);
    entry.edgeIndices.push(index);
    const caption = edgeSentence(edge, allNodes, allEdges);
    if (!entry.captions.includes(caption)) entry.captions.push(caption);
    pending.set(neighbor.id, entry);
  });

  // 按原节点顺序输出，新增边或改变边排列不会让已有卡片任意跳位。
  const entries: AnalysisEntry[] = [];
  allNodes.forEach(node => {
    const entry = pending.get(node.id);
    if (!entry) return;

    const hasUpstream = entry.lanes.has('upstream');
    const hasDownstream = entry.lanes.has('downstream');
    let lane: AnalysisLane = 'context';
    const captions = [...entry.captions];
    if (hasUpstream && hasDownstream) {
      captions.push('同时存在两个方向的直接关系，放在上下文中逐条核对，不归为单向影响。');
    } else if (hasUpstream) {
      lane = 'upstream';
    } else if (hasDownstream) {
      lane = 'downstream';
      captions.push('修改焦点时建议复核此项，不代表它必然受到影响或必须修改。');
    }

    // 未决问题不作为已经成立的设计前提；仍保留原边语义供用户阅读。
    if (focus.status === 'question' || node.status === 'question') {
      captions.push('涉及未决问题，作为讨论背景阅读，不推定为已经确定的影响关系。');
    }

    // 包含或相关边与明确方向边并存时，沿用明确方向，同时保留所有关系语句。
    entries.push({ node: entry.node, lane, edgeIndices: [...entry.edgeIndices], captions });
  });

  return { focus, entries, visibleIds, edgeIndices };
}
