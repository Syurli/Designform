import type { ProjectSnapshot, RelationType } from '../shared/model';
import type { GraphEdit } from '../shared/graph-editing';
import { pickDocument } from './document-picker';
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** 小型选择只呈现当前操作需要的选项，不把关系管理变成身份字段表单。 */
export function chooseAction(title:string,options:{id:string;label:string;description?:string}[]):Promise<string|null>{
  return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='document-picker-dialog';dialog.innerHTML=`<header><strong>${escape(title)}</strong><button data-choice="" aria-label="取消">×</button></header><div class="document-picker-results">${options.map(o=>`<button data-choice="${escape(o.id)}"><b>${escape(o.label)}</b>${o.description?`<span>${escape(o.description)}</span>`:''}</button>`).join('')}</div>`;
    const finish=(value:string|null)=>{dialog.close();dialog.remove();resolve(value);};dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();finish(null);});dialog.addEventListener('click',event=>{const b=(event.target as HTMLElement).closest<HTMLElement>('[data-choice]');if(b)finish(b.dataset.choice||null);});document.body.append(dialog);dialog.showModal();});
}
export async function chooseRelationType():Promise<Exclude<RelationType,'contains'>|null>{return await chooseAction('这两个条目是什么关系？',[{id:'relates',label:'普通关联',description:'两项设计有关联，没有先后方向。'},{id:'depends',label:'依赖',description:'起点依赖目标条目提供的规则。'},{id:'constrains',label:'约束',description:'起点限制目标条目的设计边界。'},{id:'references',label:'手工引用',description:'记录参考关系，正文链接另行保留。'},{id:'replaces',label:'替代',description:'起点设计替代目标设计。'}]) as Exclude<RelationType,'contains'>|null;}
export async function classifyDocuments(snapshot:ProjectSnapshot,ids:string[]):Promise<GraphEdit|undefined>{const group=await chooseAction('移入哪个设计分类？',[...snapshot.groups.filter(g=>g.id!=='system-unassigned').map(g=>({id:g.id,label:g.label})),{id:'system-unassigned',label:'暂不归类'}]);return group?{kind:'classify',ids,group}:undefined;}
export async function connectDocuments(snapshot:ProjectSnapshot,source:string):Promise<GraphEdit|undefined>{const target=await pickDocument(snapshot,{title:'选择要关联的设计',exclude:[source]});if(!target||typeof target==='string')return;const type=await chooseRelationType();return type?{kind:'connect',source,target:target.id,type}:undefined;}

/** 派生线和手工线提供各自的修改入口，正文引用按出现位置精确处理。 */
export async function editEdge(snapshot:ProjectSnapshot,id:string):Promise<GraphEdit|undefined>{
  const edge=snapshot.edges.find(e=>e.id===id);if(!edge)return;
  const title=(nodeId:string)=>snapshot.nodes.find(n=>n.id===nodeId)?.title??'条目';
  if(edge.origin?.kind==='classification')return classifyDocuments(snapshot,[edge.target]);
  if(edge.origin?.kind==='markdown'){
    const occurrences=edge.origin.occurrences??[];
    const occurrence=await chooseAction(`「${title(edge.source)}」中的正文引用`,occurrences.map((o,i)=>({id:String(i),label:o.label,description:snapshot.documents.find(d=>d.path===edge.origin!.path)?.text.slice(Math.max(0,o.start-45),o.end+55).replace(/\n/g,' ')})));
    if(occurrence===null)return;
    const action=await chooseAction('修改这一处正文链接',[{id:'replace',label:'改为引用其他 DD'},{id:'remove',label:'移除链接，保留正文文字'}]);if(!action)return;
    if(action==='remove')return{kind:'reference',edgeId:id,occurrence:Number(occurrence)};
    const target=await pickDocument(snapshot,{title:'改为引用哪个设计？',exclude:[]});return target&&typeof target!=='string'?{kind:'reference',edgeId:id,occurrence:Number(occurrence),target:target.id}:undefined;
  }
  if(edge.origin?.kind!=='manual'){await chooseAction('这条线来自文档结构',[{id:'close',label:edge.origin?.kind==='creative'?'此关系来自共享模块字段，请在创作模块中编辑源对象':edge.origin?.kind==='section'?'章节属于所在 DD，请在正文中调整章节':'此关系来自总纲目录或问询对象，请编辑对应文档'}]);return;}
  const action=await chooseAction(`${title(edge.source)} → ${title(edge.target)}`,[{id:'target',label:'改接目标条目'},{id:'source',label:'改接来源条目'},{id:'remove',label:'断开这条手工关联',description:'正文中的引用和分类归属保持原样。'}]);if(!action)return;
  if(action==='remove')return{kind:'disconnect',edgeIds:[id]};
  const target=await pickDocument(snapshot,{title:action==='source'?'新的来源条目':'新的目标条目',exclude:[action==='source'?edge.target:edge.source]});return target&&typeof target!=='string'?{kind:'reconnect',edgeId:id,end:action as 'source'|'target',nodeId:target.id}:undefined;
}
