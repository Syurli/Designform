import * as THREE from 'three';
import type { KnowledgeData } from './data';

export type GraphDirection = 'vertical' | 'horizontal';

/** 只采用公开的包含边建立展示树。一个节点有多条归属边时按目录来源择一，避免循环及重复卡片。 */
export function hierarchyLayout(data: KnowledgeData, rootId: string | undefined, direction: GraphDirection, compact: boolean, parentOutput?: Map<string,string>, visibleIds?:Set<string>): Map<string, THREE.Vector3> {
  const ids = visibleIds??new Set(data.nodes.map(node => node.id));
  const parent = new Map<string, string>();
  const priority = (kind: string | undefined) => kind === 'section' ? 0 : kind === 'catalog' ? 1 : kind === 'classification' ? 2 : 3;
  const edges = data.edges.filter(edge => edge.type === 'contains' && ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
    .sort((a, b) => priority(a.origin?.kind) - priority(b.origin?.kind));
  for (const edge of edges) {
    if (parent.has(edge.target) || edge.target === rootId) continue;
    let cursor: string | undefined = edge.source;
    while (cursor && cursor !== edge.target) cursor = parent.get(cursor);
    if (!cursor) parent.set(edge.target, edge.source);
  }
  if (parentOutput) {parentOutput.clear();parent.forEach((value,key)=>parentOutput.set(key,value));}
  const children = new Map<string, string[]>();
  data.nodes.forEach(node => {if(ids.has(node.id))children.set(node.id, []);});
  parent.forEach((owner, child) => children.get(owner)?.push(child));
  const roots = data.nodes.map(node => node.id).filter(id => ids.has(id)&&!parent.has(id));
  if (rootId && roots.includes(rootId)) roots.splice(roots.indexOf(rootId), 1), roots.unshift(rootId);
  // 每层单独居中：首层分类不会被某个巨型子树推到屏幕外，同层卡片也不会重叠。
  const rows = new Map<number,string[]>();
  const collect = (id:string, depth:number) => {
    const row=rows.get(depth)??[];row.push(id);rows.set(depth,row);
    for(const child of children.get(id)??[])collect(child,depth+1);
  };
  roots.forEach(id=>collect(id,id===rootId?0:1));
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
