import type { FileChange, KnowledgeEdge, ProjectSnapshot, RelationType } from './model';
import { putRelation, removeRelation, setMetadata, setTitle } from './editing';
import { relativeLink, rewriteLinks } from './links';
import { readHeader } from './markdown';

/** 图形手势与菜单共用语义命令，坐标变化不进入这些公开文档操作。 */
export type GraphEdit =
  | { kind: 'classify'; ids: string[]; group: string }
  | { kind: 'connect'; source: string; target: string; type?: Exclude<RelationType,'contains'>; note?: string }
  | { kind: 'disconnect'; edgeIds: string[] }
  | { kind: 'reconnect'; edgeId: string; end: 'source'|'target'; nodeId: string }
  | { kind: 'insert'; edgeId: string; nodeId: string }
  | { kind: 'reference'; edgeId: string; occurrence: number; target?: string }
  | { kind: 'clone'; ids: string[]; group?: string };

/** 只计算变更；宿主负责哈希检查、草稿和事务提交，网页与桌面保持相同规则。 */
export function graphChanges(snapshot: ProjectSnapshot, edit: GraphEdit): { changes: FileChange[]; label: string } {
  if (snapshot.historical) throw new Error('历史版本只读，请回到最新工作稿。');
  const staged = new Map<string, FileChange>();
  const node = (id: string) => { const result=snapshot.nodes.find(item=>item.id===id); if(!result)throw new Error('目标条目已变化，请重新选择。');return result; };
  const document = (path: string) => {const result=snapshot.documents.find(item=>item.path===path);if(!result)throw new Error('找不到关系来源文档。');return result;};
  const text = (path: string) => staged.get(path)?.text ?? document(path).text;
  const change = (path: string, value: string) => staged.set(path,{path,baseHash:document(path).hash,text:value});
  const edge = (id: string) => {const result=snapshot.edges.find(item=>item.id===id);if(!result)throw new Error('关系已变化，请重新选择。');return result;};
  const remove = (value: KnowledgeEdge) => {
    if(value.origin?.kind!=='manual')throw new Error(value.origin?.kind==='markdown'?'这是正文引用，请选择具体原句后修改链接。':'这条线由文档结构派生，请使用对应的归属操作。');
    change(value.origin.path,removeRelation(text(value.origin.path),value.id));
  };
  const connect = (source: string,target: string,type: Exclude<RelationType,'contains'>='relates',note='',id=`rel-${crypto.randomUUID()}`) => {
    const a=node(source),b=node(target);
    if(source===target||a.kind==='system'||b.kind==='system')throw new Error('请选择两个不同的文档或规则；分类请使用实线归属入口。');
    if(snapshot.edges.some(item=>item.id!==id&&item.origin?.kind==='manual'&&item.type===type&&((item.source===source&&item.target===target)||(type==='relates'&&item.source===target&&item.target===source))))throw new Error('这两个条目已经有同类关系。');
    change(a.documentPath,putRelation(text(a.documentPath),a.anchor,{id,type,target,note}));
  };
  let label='编辑关系';
  if(edit.kind==='classify') {
    if(!edit.ids.length)throw new Error('请选择专项 DD、问题或有锚点的规则；总纲与分类本身不能改变归属。');
    const group=edit.group==='system-unassigned'?'':edit.group;
    if(group&&!snapshot.groups.some(item=>item.id===group))throw new Error('分类不存在。');
    for(const id of edit.ids){const item=node(id);
      if(item.kind==='rule'&&item.anchor){
        // 章节归类写在公开文档的锚点映射里；保留它属于原 GDD / DD 的真实目录关系。
        const path=item.documentPath,raw=readHeader(text(path)).metadata.sectionSystems;
        if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw new Error('章节分类元数据格式无效，请先修正文档头部。');
        const sections=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw as Record<string,unknown>}:{};
        // 缺少锚点键表示继承文档分类；用户明确取消归类必须写入未归组。
        const sectionGroup=group||'system-unassigned';
        if(sections[item.anchor]!==sectionGroup){
          sections[item.anchor]=sectionGroup;
          change(path,setMetadata(text(path),{sectionSystems:sections}));
        }
      }else if(item.kind==='document'&&item.documentType!=='gdd'){
        // 独立文档仍使用自己的 system 字段；相同归属不重排 YAML。
        if((item.group==='system-unassigned'?'':item.group)!==group)change(item.documentPath,setMetadata(text(item.documentPath),{system:group}));
      }else throw new Error('只有专项文档、问题或有锚点的规则可以改变分类。');
    }
    label=group?`移入${snapshot.groups.find(item=>item.id===group)!.label}`:'取消归类';
  } else if(edit.kind==='connect') {connect(edit.source,edit.target,edit.type,edit.note);label='建立设计关联';}
  else if(edit.kind==='disconnect') {edit.edgeIds.forEach(id=>remove(edge(id)));label=`解除 ${edit.edgeIds.length} 条手工关联`;}
  else if(edit.kind==='reconnect') {const value=edge(edit.edgeId);if(value.origin?.kind!=='manual')throw new Error('只有手工关联可以改接。');
    // 拖回原端点时连表格中的空白和换行也保持原样。
    if(edit.nodeId!==(edit.end==='source'?value.source:value.target)){remove(value);connect(edit.end==='source'?edit.nodeId:value.source,edit.end==='target'?edit.nodeId:value.target,value.type as Exclude<RelationType,'contains'>,value.note,value.id);}label='改接设计关联';}
  else if(edit.kind==='insert') {const value=edge(edit.edgeId);if(value.type!=='relates'||edit.nodeId===value.source||edit.nodeId===value.target)throw new Error('仅支持在普通关联中插入另一个条目。');remove(value);connect(value.source,edit.nodeId,'relates',value.note);connect(edit.nodeId,value.target,'relates',value.note);label='插入普通关联';}
  else if(edit.kind==='reference') {
    const value=edge(edit.edgeId),origin=value.origin,occurrence=origin?.occurrences?.[edit.occurrence];
    if(origin?.kind!=='markdown'||!occurrence)throw new Error('请选择实际的正文引用位置。');
    // 引用式链接可能共用定义，只替换所选引用为行内链接，不改其他使用同一定义的句子。
    const source=text(origin.path),raw=source.slice(occurrence.start,occurrence.end);
    let closing=0,depth=0;for(let i=0;i<raw.length;i++){if(raw[i]==='\\'){i++;continue;}if(raw[i]==='[')depth++;if(raw[i]===']'&&--depth===0){closing=i;break;}}
    const labelText=closing?raw.slice(1,closing):occurrence.label.replace(/[\[\]]/g,'');
    let replacement=labelText;
    if(edit.target){const target=node(edit.target);if(target.kind==='system')throw new Error('请选择文档或规则。');replacement=`[${labelText}](${relativeLink(origin.path,target.documentPath)}${target.anchor?'#'+target.anchor:''})`;}
    change(origin.path,source.slice(0,occurrence.start)+replacement+source.slice(occurrence.end));label=edit.target?'修改一处正文引用':'取消一处链接，保留文字';
  } else if(edit.kind==='clone') {
    const originals=[...new Set(edit.ids.map(id=>node(id).documentId))].map(id=>snapshot.documents.find(doc=>doc.id===id)!);
    if(originals.some(doc=>!doc||doc.type==='gdd'||doc.type==='guide'))throw new Error('请选择专项 DD 或问题；总纲不会复制成第二个核心。');
    const identities=new Map(originals.map(doc=>[doc.id,`${doc.type}-${crypto.randomUUID()}`]));
    const paths=new Map(originals.map(doc=>[doc.path,`docs/${doc.type==='question'?'questions':'dd'}/${identities.get(doc.id)}.md`]));
    for(const doc of originals){
      let value=setTitle(setMetadata(doc.text,{id:identities.get(doc.id),...(edit.group!==undefined?{system:edit.group==='system-unassigned'?'':edit.group}:{})}),`${doc.title} · 副本`);
      value=rewriteLinks(value,doc.path,paths.get(doc.path)!,paths);
      // 手工关系用结构解析逐条重建，避免替换正文内恰好出现的身份字符串。
      for(const rel of snapshot.edges.filter(item=>item.origin?.kind==='manual'&&item.origin.path===doc.path)){
        value=removeRelation(value,rel.id);
        const parts=rel.target.split('/'),target=(identities.get(parts[0])??parts[0])+(parts[1]?'/'+parts[1]:'');
        value=putRelation(value,rel.source.split('/')[1],{id:`rel-${crypto.randomUUID()}`,type:rel.type,target,note:rel.note});
      }
      if(doc.type==='question'){const metadata=readHeader(value).metadata;if(Array.isArray(metadata.targets))value=setMetadata(value,{targets:metadata.targets.map(target=>{const parts=String(target).split('/');return (identities.get(parts[0])??parts[0])+(parts[1]?'/'+parts[1]:'');})});}
      staged.set(paths.get(doc.path)!,{path:paths.get(doc.path)!,baseHash:null,text:value});
    }
    label=`复制 ${originals.length} 份文档`;
  }
  return {changes:[...staged.values()].filter(item=>item.baseHash===null||item.text!==document(item.path).text),label};
}
