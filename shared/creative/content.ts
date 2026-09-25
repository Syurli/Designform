import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument, stringify } from 'yaml';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ProjectSnapshot, ProjectDocument } from '../model.ts';
import { parseDesignBlock, serializeDesignBlock, type DesignBlock } from '../design-blocks.ts';
import { asRows, asStrings, asString, objectIdPattern, type CreativeObject, type LocatedObject, type CreativeIndex, type Data, type ModuleField } from './model.ts';
import { moduleRegistry, validateObject } from './registry.ts';
export const contentHash = (text:string) => bytesToHex(sha256(new TextEncoder().encode(text)));
export const MEDIA_PATH = /^assets\/objects\/([a-f0-9]{64})\/content\.(png|jpg|webp|gif|wav|mp3|ogg|m4a)$/;
export function parseObject(source:string):CreativeObject {
 const doc=parseDocument(source,{uniqueKeys:true});if(doc.errors.length)throw new Error(doc.errors[0].message);
 const v:unknown=doc.toJS({maxAliasCount:20});
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('创作模块必须为对象');
 const o=v as CreativeObject;if(typeof o.id!=='string'||!objectIdPattern.test(o.id)||typeof o.type!=='string'||typeof o.title!=='string')throw new Error('创作模块身份、类型或标题无效');
 return o;
}
// 解析缓存以内容、身份与路径为键；不会按旧修订复用已修改正文。有限 LRU 不缓存私人数据。
const documentCache=new Map<string,{text:string;value:{objects:LocatedObject[];diagnostics:CreativeIndex['diagnostics']}}>();
let cachedCharacters=0;
const snapshotCache=new WeakMap<object,{documents:ProjectDocument[];index:CreativeIndex}>();
function retainScan(key:string,text:string,value:{objects:LocatedObject[];diagnostics:CreativeIndex['diagnostics']}) {
 documentCache.set(key,{text,value});cachedCharacters+=text.length;
 while(documentCache.size>2048||cachedCharacters>16*1024*1024){const first=documentCache.keys().next().value;if(!first)break;cachedCharacters-=documentCache.get(first)!.text.length;documentCache.delete(first);}
 return value;
}
/** 从 Markdown AST 读取真实围栏，不把代码示例中的字面内容当作第二份对象。 */
export function scanObjects(doc:Pick<ProjectDocument,'id'|'path'|'hash'|'text'>):{objects:LocatedObject[];diagnostics:CreativeIndex['diagnostics']} {
 const cacheKey=`${doc.id}:${doc.path}:${doc.hash||contentHash(doc.text)}`,cached=documentCache.get(cacheKey);if(cached&&cached.text===doc.text){documentCache.delete(cacheKey);documentCache.set(cacheKey,cached);return cached.value;}
 const objects:LocatedObject[]=[],diagnostics:CreativeIndex['diagnostics']=[];
 for(const node of fromMarkdown(doc.text).children){if(node.type!=='code'||!['cewen-object','cewen-dialogue','cewen-palette'].includes(node.lang??''))continue;
  const start=node.position!.start.offset!,end=node.position!.end.offset!,source=doc.text.slice(start,end);
  try {
   let object:CreativeObject;
   if(node.lang==='cewen-object')object=parseObject(node.value);
   else {const legacy=parseDesignBlock(node.lang!,node.value)!;object={schema:1,id:legacy.id,type:legacy.kind,title:legacy.title,data:JSON.parse(JSON.stringify(legacy))};}
   if(node.lang==='cewen-object'){
    if(!moduleRegistry.has(object.type)||object.schema!==1)diagnostics.push({path:doc.path,code:'UNKNOWN_MODULE',severity:'warning',message:`${object.title} 使用未识别模块，原文保留。`});
    else for(const error of validateObject(object))diagnostics.push({path:doc.path,code:'INVALID_MODULE',severity:'error',message:`${object.title}：${error}`});
   }
   objects.push({object,documentId:doc.id,path:doc.path,documentHash:doc.hash,start,end,source,hash:contentHash(source),language:node.lang!});
  }catch(e){diagnostics.push({path:doc.path,code:'INVALID_MODULE',severity:'error',message:e instanceof Error?e.message:'模块无法解析'});}
 }
 return retainScan(cacheKey,doc.text,{objects,diagnostics});
}
export function buildCreativeIndex(snapshot:Pick<ProjectSnapshot,'documents'>):CreativeIndex {
 const cached=snapshotCache.get(snapshot);if(cached?.documents===snapshot.documents)return cached.index;
 const result:CreativeIndex={objects:[],references:[],diagnostics:[]},seen=new Set<string>();
 for(const doc of snapshot.documents){const parsed=scanObjects(doc);result.diagnostics.push(...parsed.diagnostics);for(const item of parsed.objects){if(seen.has(item.object.id))result.diagnostics.push({path:item.path,code:'DUPLICATE_OBJECT',severity:'error',message:`重复对象身份 ${item.object.id}`});seen.add(item.object.id);result.objects.push(item);}}
 for(const item of result.objects)for(const dep of moduleRegistry.get(item.object.type)?.dependencies(item.object)??[]){result.references.push({ownerId:item.object.id,targetId:dep.id,role:dep.role,path:item.path});if(!seen.has(dep.id))result.diagnostics.push({path:item.path,code:'MISSING_OBJECT',severity:'warning',message:`${item.object.title} 的 ${dep.role} 指向缺失对象 ${dep.id}`});}
 // 引用类型由统一字段注册表决定；不能把配音或角色误挂到地图字段。
 const byId=new Map(result.objects.map(x=>[x.object.id,x.object]));
 for(const item of result.objects){const check=(data:Data,fields:ModuleField[],prefix='')=>{for(const field of fields){if(field.kind==='rows')for(const row of asRows(data[field.key]))check(row,field.fields??[],prefix+field.label+' / ');else if(field.objectType){const ids=field.kind==='objects'?asStrings(data[field.key]):[asString(data[field.key])].filter(Boolean);for(const id of ids){const target=byId.get(id);if(target&&target.type!==field.objectType)result.diagnostics.push({path:item.path,code:'WRONG_OBJECT_TYPE',severity:'error',message:`${item.object.title} 的 ${prefix+field.label} 必须引用 ${field.objectType}，不能引用 ${target.type}`});}}}};check(item.object.data,moduleRegistry.get(item.object.type)?.fields??[]);}
 snapshotCache.set(snapshot,{documents:snapshot.documents,index:result});return result;
}
export function objectBlock(object:CreativeObject){return '```cewen-object\n'+stringify(object,{lineWidth:0,aliasDuplicateObjects:false}).trimEnd()+'\n```';}
/** 仅替换选中对象的源码范围，无关正文与未知模块逐字保留。 */
export function replaceObject(text:string,located:LocatedObject,object:CreativeObject|null):string {
 if(contentHash(text.slice(located.start,located.end))!==located.hash)throw new Error('对象原文已变化，请重新读取');
 const block=object===null?'':located.language==='cewen-object'?objectBlock(object):'```'+located.language+'\n'+serializeDesignBlock({...object.data,id:object.id,title:object.title,kind:object.type} as DesignBlock).trimEnd()+'\n```';
 return text.slice(0,located.start)+block+text.slice(located.end);
}
export function collectMediaFromTexts(files:Iterable<[string,Uint8Array]>):Record<string,string>{
 const media:Record<string,string>={};for(const [path,bytes] of files){if(!path.startsWith('docs/')||!path.endsWith('.md'))continue;
  const parsed=scanObjects({id:path,path,hash:'',text:new TextDecoder().decode(bytes)});
  for(const {object} of parsed.objects)if(object.type==='media'){
   const path=asString(object.data.path),hash=asString(object.data.sha256),match=MEDIA_PATH.exec(path);
   if(!match||match[1]!==hash)throw new Error(`媒体 ${object.id} 的内容地址与 SHA256 不一致`);
   media[path]=hash;
  }
 }
 return media;
}
export function objectContext(index:CreativeIndex,ids:string[],budget=100000){
 const byId=new Map(index.objects.map(x=>[x.object.id,x])),dependencies=new Map<string,string[]>();for(const r of index.references){const list=dependencies.get(r.ownerId)??[];list.push(r.targetId);dependencies.set(r.ownerId,list);}
 const selected=new Map<string,LocatedObject>(),queue=[...ids];let cursor=0;while(cursor<queue.length){const id=queue[cursor++];if(selected.has(id))continue;const item=byId.get(id);if(!item)throw new Error(`找不到对象 ${id}`);selected.set(id,item);if(selected.size>200)throw new Error('对象依赖超过 200 个，请缩小范围');for(const target of dependencies.get(id)??[])if(!selected.has(target))queue.push(target);}
 const objects=[...selected.values()].map(({object,path,documentHash,hash})=>({object,path,documentHash,hash}));if(JSON.stringify(objects).length>budget)throw new Error('对象上下文超出预算，请分段读取；没有静默截断');return objects;
}
