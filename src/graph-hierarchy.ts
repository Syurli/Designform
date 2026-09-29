import * as THREE from 'three';
import type { KnowledgeData } from './data';
import { buildGraphHierarchy } from './graph-structure';

export type GraphDirection = 'vertical' | 'horizontal';

/** 采用公开包含边与分类元数据建立展示树，多条归属边按目录来源择一，避免循环及重复卡片。 */
export function hierarchyLayout(data: KnowledgeData, rootId: string | undefined, direction: GraphDirection, compact: boolean, parentOutput?: Map<string,string>, visibleIds?:Set<string>): Map<string, THREE.Vector3> {
  const ids = visibleIds??new Set(data.nodes.map(node => node.id));
  const hierarchy = buildGraphHierarchy(data, rootId, true);
  const parent = hierarchy.parent;
  if (parentOutput) {parentOutput.clear();parent.forEach((value,key)=>parentOutput.set(key,value));}
  // 每层单独居中：首层分类不会被某个巨型子树推到屏幕外，同层卡片也不会重叠。
  const rows = new Map<number,string[]>();
  // 迭代展开完整结构，筛选只裁去卡片，不压平真实层级，也不依赖固定层数。
  const stack = [...hierarchy.roots].reverse();
  while (stack.length) {
    const id = stack.pop()!, depth = hierarchy.depth.get(id)!;
    if (ids.has(id)) { const row = rows.get(depth) ?? []; row.push(id); rows.set(depth, row); }
    stack.push(...[...(hierarchy.children.get(id) ?? [])].reverse());
  }
  const result = new Map<string, THREE.Vector3>();
  const depthGap = compact ? 145 : direction==='vertical'?180:260;
  const siblingGap = compact ? 100 : direction==='vertical'?224:144;
  rows.forEach((row,depth)=>row.forEach((id,index)=>{
    const axis=(index-(row.length-1)/2)*siblingGap;
    result.set(id,direction==='vertical'?new THREE.Vector3(axis,-depth*depthGap,0):new THREE.Vector3(depth*depthGap,-axis,0));
  }));
  // 平移基准必须复制；若直接引用根节点，遍历到根时基准归零，后续节点会错位。
  const core = rootId && result.get(rootId)?.clone();
  if (core) result.forEach(point => point.sub(core));
  return result;
}
