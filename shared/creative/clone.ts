import {asData,asString,type CreativeObject} from './model.ts';
/** 对象独立复制只重建自有子身份；指向外部角色、地点与媒体的引用保持显式共享。 */
export function cloneCreativeObject(source:CreativeObject,newId:string,newChildId:()=>string):CreativeObject {
 const next=structuredClone(source),ids=new Map<string,string>();next.id=newId;next.title+=' · 独立副本';
 const scan=(value:unknown)=>{if(Array.isArray(value))value.forEach(scan);else if(value&&typeof value==='object'){const row=asData(value);if(typeof row.id==='string')ids.set(row.id,newChildId());Object.values(row).forEach(scan);}};scan(next.data);
 const rewrite=(value:unknown)=>{if(Array.isArray(value))value.forEach(rewrite);else if(value&&typeof value==='object'){const row=asData(value);for(const key of Object.keys(row)){const v=row[key];if(key==='id'&&typeof v==='string'&&ids.has(v))row[key]=ids.get(v)!;else if(['start','next','selectedPath'].includes(key)&&typeof v==='string')row[key]=v.split(',').map(s=>ids.get(s.trim())??s.trim()).join(',');else rewrite(v);}}};rewrite(next.data);
 if(next.type==='quest')next.data.rounds=[];if(next.type==='decision')delete next.data.confirmation;
 return next;
}
