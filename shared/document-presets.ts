import { readHeader } from './markdown';
import { setMetadata, setTitle } from './editing';
import { ensureBlockIds, parseDocumentBlocks } from './document-blocks';
import { objectBlock, buildCreativeIndex, parseObject } from './creative/content';
import { moduleRegistry } from './creative/registry';
import type { LayoutCompanion } from './document-companion';
import { validateLayoutCompanion } from './document-companion';
import type { ModuleField,Data } from './creative/model';

/** 文档预设保存一份基础文档的组合，项目预设仍负责多份文档的起步目录。 */
export interface DocumentPreset {
  format: 1; id: string; name: string; description: string; purpose: string; tags: string[];
  markdown: string; layout?: LayoutCompanion; assets?: Record<string,string>;
  source: 'builtin' | 'user'; pinned?: boolean; updatedAt?: string;
}
function builtin(id: string, name: string, purpose: string, body: string, modules: string[] = []): DocumentPreset {
  const objects = modules.map((type,index) => moduleRegistry.get(type)!.create(`preset-${id}-${index}`));
  return { format:1,id:'builtin-'+id,name,purpose,tags:[purpose],source:'builtin',description:`${name}的起步组合；全部内容均可自由修改。`,markdown:`---\nid: preset-${id}\ntype: dd\nstatus: draft\npurpose: ${purpose}\n---\n\n# ${name}\n\n${body}\n\n${objects.map(objectBlock).join('\n\n')}` };
}
export const builtinDocumentPresets: DocumentPreset[] = [
  builtin('character','角色卡','角色','## 人物简介\n\n在这里描述人物。\n\n## 外观与参考\n\n插入图片或声音。',['character']),
  builtin('map','地图卡','地图','## 空间说明\n\n在这里说明地图用途。\n\n## 图例与地点\n\n为标注补充说明。',['map']),
  builtin('item','道具卡','道具','## 用途与规则\n\n在这里描述道具。\n\n## 外观与参考\n\n插入图片。',['fields']),
  builtin('location','地点资料','地点','## 空间描述\n\n在这里描述地点。',['location']),
  builtin('scene','场次文档','场次','## 场次目标\n\n在这里描述本场发生的事。\n\n## 正文\n\n在此插入角色引用和对白。',['scene']),
  builtin('rule','规则说明','规则','## 目标体验\n\n## 规则正文\n\n## 待讨论问题\n'),
];
export function validateDocumentPreset(value: unknown): asserts value is DocumentPreset {
  const p=value as DocumentPreset;
  if(!p||p.format!==1||!/^user-[A-Za-z0-9_-]+$/.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>100||typeof p.markdown!=='string'||p.markdown.length>2000000||p.source!=='user'||!Array.isArray(p.tags)||p.tags.some(t=>typeof t!=='string')||typeof p.description!=='string'||typeof p.purpose!=='string')throw new Error('文档预设格式或名称无效。');
  if(p.assets && Object.entries(p.assets).some(([name,bytes])=>!/^docs\/assets\/[A-Za-z0-9_./-]+$/.test(name)||name.includes('..')||typeof bytes!=='string'||bytes.length>24000000))throw new Error('预设素材格式无效。');
  if(p.layout&&!validateLayoutCompanion(p.layout))throw new Error('预设布局无效。');
}
/** 每次实例化重新分配文档、模块、块与行身份；内部引用随身份映射，原预设不被修改。 */
export function instantiateDocumentPreset(preset: DocumentPreset, title = preset.name) {
  const text=ensureBlockIds(preset.markdown), ids=new Map<string,string>();
  const oldDoc=String(readHeader(text).metadata.id??'preset-document'); ids.set(oldDoc,'doc-'+crypto.randomUUID());
  const collect=(value:unknown):void=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(collect);return;}for(const [key,item] of Object.entries(value)){if(key==='id'&&typeof item==='string'&&!ids.has(item))ids.set(item,'item-'+crypto.randomUUID());else collect(item);}};
  for(const block of parseDocumentBlocks(text)){if(block.id&&!ids.has(block.id))ids.set(block.id,'block-'+crypto.randomUUID());}
  for(const group of Object.keys(preset.layout?.groups??{}))ids.set(group,'group-'+crypto.randomUUID());
  const index=buildCreativeIndex({documents:[{id:oldDoc,path:'docs/preset.md',title:preset.name,type:'dd',status:'draft',system:'',text,hash:''}]});
  index.objects.forEach(item=>collect(item.object));
  const rewrite=(source:string)=>{for(const [from,to] of [...ids].sort((a,b)=>b[0].length-a[0].length))source=source.replace(new RegExp('(?<![A-Za-z0-9_-])'+from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9_-])','g'),to);return source;};
  let markdown=setTitle(setMetadata(rewrite(text),{id:ids.get(oldDoc),type:'dd',status:'draft',purpose:preset.purpose,presetSource:preset.id,system:undefined,parent:undefined,example:undefined}),title);
  const layout=preset.layout?JSON.parse(rewrite(JSON.stringify(preset.layout))) as LayoutCompanion:undefined;
  if(layout)layout.documentId=ids.get(oldDoc)!;
  const assets:Record<string,string>={},assetRoot='preset-'+crypto.randomUUID();
  for(const [original,bytes] of Object.entries(preset.assets??{})){const name=`docs/assets/${assetRoot}/${crypto.randomUUID()+'-'+original.split('/').at(-1)}`;assets[name]=bytes;markdown=markdown.replaceAll(original.slice(5),name.slice(5));}
  return {id:ids.get(oldDoc)!,markdown,layout,assets};
}
/** 默认只提取结构；外部对象引用变成占位，不把源工程身份写进新预设。 */
export function captureDocumentPreset(markdown: string, name: string, keepContent: boolean, layout?: LayoutCompanion, keepAssets=false): DocumentPreset {
  let text=markdown;
  const objects=buildCreativeIndex({documents:[{id:String(readHeader(text).metadata.id),path:'docs/preset.md',title:name,type:'dd',status:'draft',system:'',text,hash:''}]}).objects;
  const localIds=new Set(objects.filter(item=>item.object.type!=='media').map(item=>item.object.id));
  for(const item of [...objects].reverse()){
    if(item.object.type==='media'){text=text.slice(0,item.start)+'待选择媒体：'+item.object.title+'\n'+text.slice(item.end);continue;}
    const object=structuredClone(item.object),definition=moduleRegistry.get(object.type);
    const clean=(value:Record<string,unknown>)=>{for(const [key,entry] of Object.entries(value)){if(key.endsWith('Id')&&typeof entry==='string'&&!localIds.has(entry))value[key]='';else if(key.endsWith('Ids')&&Array.isArray(entry))value[key]=entry.filter(id=>localIds.has(String(id)));else if(Array.isArray(entry))entry.forEach(v=>{if(v&&typeof v==='object')clean(v as Record<string,unknown>);});else if(entry&&typeof entry==='object')clean(entry as Record<string,unknown>);}};
    clean(object.data);
    if(!keepContent&&definition){
      // 字段名称、行身份与内部引用构成结构，不能随实例值一并清空。
      const empty=(data:Data,fields:ModuleField[]):Data=>Object.fromEntries(fields.filter(f=>data[f.key]!==undefined).map(f=>{
        const v=data[f.key];if(f.key==='id'||f.key==='label')return [f.key,v];
        if(f.kind==='rows')return [f.key,Array.isArray(v)?v.map(row=>empty(row as Data,f.fields??[])):[]];
        if(f.kind==='object'||f.kind==='objects'||f.kind==='select'||f.kind==='number')return [f.key,v];
        return [f.key,f.required?'待填写':''];
      }));
      object.data=empty(object.data,definition.fields);object.title=definition.title;object.description='';
    }
    text=text.slice(0,item.start)+objectBlock(object)+text.slice(item.end);
  }
  if(!keepContent){text=ensureBlockIds(text);const blocks=parseDocumentBlocks(text);for(const block of [...blocks].reverse())if(!['heading','code','thematicBreak'].includes(block.type))text=text.slice(0,block.sourceStart)+(keepAssets&&block.type==='paragraph'?(block.source.match(/!\[[^\]]*\]\([^)]+\)/g)?.join('\n')||'在这里填写内容。'):'在这里填写内容。')+'\n'+text.slice(block.end);}
  // 文档级外部链接不作为隐式依赖复制；同文档锚点继续保留。
  text=text.replace(/!?\[([^\]]*)\]\((?!#)([^)]+)\)/g,(match,label,url)=>keepAssets&&match.startsWith('!')&&/^(?:\.\.\/)?assets\//.test(url)?match:`待选择引用：${label||'素材'}`);
  text=setTitle(setMetadata(text,{system:undefined,parent:undefined,example:undefined}),name);
  return {format:1,id:'user-'+crypto.randomUUID(),name,description:'',purpose:String(readHeader(text).metadata.purpose??''),tags:[],source:'user',markdown:text,...(layout?{layout:structuredClone(layout)}:{}),updatedAt:new Date().toISOString()};
}
