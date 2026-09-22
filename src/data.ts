import type { KnowledgeData, KnowledgeNode, KnowledgeEdge, KnowledgeGroup } from '../shared/model.ts';

/** 展示层沿用统一类型；真实内容来自项目目录，不再在源码中嵌入游戏策划。 */
export * from '../shared/model.ts';
export { relationTypes as types } from '../shared/model.ts';

/** 当前页面的读取投影；其正文由本地服务从公开 Markdown 构建。 */
export let nodes: KnowledgeNode[] = [];
export let edges: KnowledgeEdge[] = [];
export let groups: KnowledgeGroup[] = [];

/** 切换项目或完成文件保存后整体替换投影，不复制出独立可编辑正文。 */
export function setKnowledgeData(data: KnowledgeData) { nodes = data.nodes; edges = data.edges; groups = data.groups; }
