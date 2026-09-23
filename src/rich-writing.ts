import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { imageSchema, toggleStrongCommand, wrapInHeadingCommand } from '@milkdown/kit/preset/commonmark';
import { TextSelection } from '@milkdown/kit/prose/state';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';

const tree=(text:string)=>fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]});
/** 功能索引沿用原有段落间距，打开再保存不得平白增添空行。 */
const joinTail=(body:string,tail:string)=>tail?body+(/\n\s*\n$/.test(body)?'':'\n\n')+tail:body;
/** 只比较语义，位置与解析器附加缓存不影响原文片段是否可以直接保留。 */
const key=(node:Nodes):string=>JSON.stringify(node,(name,value)=>name==='position'||name==='data'?undefined:value);
export function richBodyParts(body:string){
  const nodes=tree(body).children,at=nodes.findIndex(node=>node.type==='heading'&&node.depth===3&&node.children.length===1&&node.children[0].type==='text'&&node.children[0].value==='关联索引');
  if(at<0)return {body,tail:''};
  const tail=nodes.slice(at);
  if(tail.some(node=>node.type!=='table'&&!(node.type==='heading'&&node.children[0]?.type==='text'&&node.children[0].value==='关联索引')))return {body,tail:''};
  const offset=nodes[at].position!.start.offset!;return {body:body.slice(0,offset),tail:body.slice(offset)};
}
/** 特殊 HTML 使用源码；知识锚点与编辑器自身输出的空行标记可以无损保留。 */
export function richUnsupported(text:string){
  let reason='';
  const inspect=(node:Nodes)=>{
    if(node.type==='html'&&!/^\s*(?:<br\s*\/?>|<a\s+id=["'][\w-]+["']\s*>|<\/a>|<a\s+id=["'][\w-]+["']\s*>\s*<\/a>)\s*$/.test(node.value))reason='这份文档含有自定义 HTML，已使用源码编辑以保留原文。';
    if('children' in node)node.children.forEach(inspect);
  };tree(text).children.forEach(inspect);
  if(/^\[\^[^\]]+\]:|^:::/m.test(text))reason='这份文档含有扩展语法，已使用源码编辑以保留原文。';
  return reason;
}
/** 未变化的段落、表格和代码沿用原始 Markdown；只有修改的块使用编辑器输出。 */
function preserveBlocks(original:string,next:string){
  const a=tree(original).children,b=tree(next).children;
  if(JSON.stringify(a.map(key))===JSON.stringify(b.map(key)))return original;
  const used=new Set<number>();let previous=-2;
  return b.map((node,index)=>{
    const match=a.findIndex((old,i)=>!used.has(i)&&key(old)===key(node));
    const prefix=index===0?(match===0?original.slice(0,a[0].position!.start.offset!):''):(previous>=0&&match===previous+1?original.slice(a[previous].position!.end.offset!,a[match].position!.start.offset!):'\n\n');
    const value=match<0?next.slice(node.position!.start.offset!,node.position!.end.offset!):original.slice(a[match].position!.start.offset!,a[match].position!.end.offset!);
    if(match>=0)used.add(match);previous=match;
    // 空原文或新增块的 match 为 -1，不能把它误当成最后一个原块读取位置。
    return prefix+value+(index===b.length-1?(match>=0&&match===a.length-1?original.slice(a[match].position!.end.offset!):'\n'):'');
  }).join('');
}

/** 块编辑器只处理正文，身份、关系索引和版本仍由策问工作台维护。 */
export class RichWriting {
  private crepe:Crepe;
  private ready=false;
  private disposed=false;
  private silent=false;
  private baseline='';
  private original:string;
  private tail:string;
  private selection?:{from:number;to:number};
  private observer?:MutationObserver;
  private uploadError(error:unknown){
    const box=this.root.closest('dialog')?.querySelector<HTMLElement>('#workbench-feedback');
    if(box){box.hidden=false;box.classList.add('error');box.textContent=`图片未能加入草稿：${error instanceof Error?error.message:'请重试或改用源码编辑。'}`;}
  }
  constructor(private root:HTMLElement,body:string,private onChange:(body:string)=>void,upload:(file:File)=>Promise<string>,resolveImage:(url:string)=>string,private onLink:()=>void){
    const part=richBodyParts(body);this.original=part.body;this.tail=part.tail;
    this.crepe=new Crepe({root,defaultValue:part.body,features:{[Crepe.Feature.Latex]:false,[Crepe.Feature.CodeMirror]:false},featureConfigs:{
      [Crepe.Feature.Placeholder]:{text:'写下设计，输入 / 插入内容，输入 [[ 引用其他 DD',mode:'doc'},
      [Crepe.Feature.ImageBlock]:{onUpload:async file=>{try{return await upload(file);}catch(error){this.uploadError(error);throw error;}},proxyDomURL:resolveImage,inlineUploadButton:'选择图片',inlineUploadPlaceholderText:'或粘贴图片链接',blockUploadButton:'选择图片',blockConfirmButton:'插入',blockCaptionPlaceholderText:'图片说明',blockUploadPlaceholderText:'或粘贴图片链接'},
      [Crepe.Feature.LinkTooltip]:{inputPlaceholder:'粘贴网址；项目文档请按 Ctrl+K'},
      [Crepe.Feature.BlockEdit]:{textGroup:{label:'正文',text:{label:'段落'},h1:{label:'一级标题'},h2:{label:'二级标题'},h3:{label:'三级标题'},h4:{label:'四级标题'},h5:{label:'五级标题'},h6:{label:'六级标题'},quote:{label:'引用'},divider:{label:'分隔线'}},listGroup:{label:'列表',bulletList:{label:'项目列表'},orderedList:{label:'编号列表'},taskList:{label:'待办清单'}},advancedGroup:{label:'插入',image:{label:'图片'},table:{label:'表格'},codeBlock:{label:'代码块'},math:null},slashMenu:{root},blockHandle:{root}},
    }});
    // 图片块保留真实 Markdown alt；缩放 ratio 只属于编辑器视图，不再编码成 ![1.00]。
    this.crepe.editor.config(ctx=>{
      ctx.update(imageBlockSchema.key,previous=>current=>{
        const schema=previous(current);
        return {...schema,
          attrs:{...schema.attrs,alt:{default:'',validate:'string'}},
          parseDOM:[{tag:'img[data-type="image-block"]',getAttrs:dom=>({src:dom.getAttribute('src')||'',caption:dom.getAttribute('caption')||'',alt:dom.getAttribute('alt')||'',ratio:Number(dom.getAttribute('ratio')??1)})}],
          parseMarkdown:{match:({type})=>type==='image-block',runner:(state,node,type)=>state.addNode(type,{src:String(node.url??''),caption:String(node.title??''),alt:String(node.alt??''),ratio:1})},
          toMarkdown:{match:node=>node.type.name==='image-block',runner:(state,node)=>{state.openNode('paragraph');state.addNode('image',undefined,undefined,{url:node.attrs.src,alt:node.attrs.alt,title:node.attrs.caption||null});state.closeNode();}},
        };
      });
      // 行内图片同样允许 Markdown 无 title，避免 null 进入字符串属性。
      ctx.update(imageSchema.key,previous=>current=>{
        const schema=previous(current);
        return {...schema,
          parseMarkdown:{match:({type})=>type==='image',runner:(state,node,type)=>state.addNode(type,{src:String(node.url??''),alt:String(node.alt??''),title:String(node.title??'')})},
          toMarkdown:{match:node=>node.type.name==='image',runner:(state,node)=>state.addNode('image',undefined,undefined,{url:node.attrs.src,alt:node.attrs.alt,title:node.attrs.title||null})},
        };
      });
    });
    // Crepe 的粘贴/拖入插件在上传拒绝时不移除占位；返回空节点走其既有完成路径清理占位。
    this.crepe.editor.config(ctx=>ctx.update(uploadConfig.key,previous=>({...previous,uploader:async(...args)=>{try{return await previous.uploader(...args);}catch{return [];}}})));
    this.crepe.on(api=>api.markdownUpdated((_ctx,markdown)=>{
      if(!this.ready||this.silent||this.disposed||markdown===this.baseline)return;
      // 保留原文失败时维持旧基准，保存前 read() 仍可重新取得编辑器里的输入。
      const body=preserveBlocks(this.original,markdown);
      this.onChange(joinTail(body,this.tail));
      this.original=body;this.baseline=markdown;
    }));
    root.addEventListener('keydown',this.keydown,true);
    root.addEventListener('keyup',this.keyup);
  }
  async create(){await this.crepe.create();if(this.disposed){await this.crepe.destroy();return;}this.baseline=this.crepe.getMarkdown();const semantic=(text:string)=>JSON.stringify(tree(text).children,(name,value)=>['position','data','spread'].includes(name)?undefined:typeof value==='string'?value.replace(/\r\n/g,'\n'):value);if(semantic(this.original)!==semantic(this.baseline)){this.ready=true;throw new Error('此文档的块结构无法无损往返，请保留源码编辑。');}this.ready=true;this.root.querySelector('.ProseMirror')?.setAttribute('aria-label','策划正文');this.root.querySelector('.ProseMirror')?.setAttribute('role','textbox');this.root.querySelector('.ProseMirror')?.setAttribute('aria-multiline','true');}
  private keydown=(event:KeyboardEvent)=>{if(event.isComposing)return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopPropagation();this.rememberSelection();this.onLink();}};
  private keyup=(event:KeyboardEvent)=>{if(!this.ready||event.isComposing||event.key!=='[')return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),{from}=view.state.selection;if(view.state.doc.textBetween(Math.max(0,from-2),from)==='[['){this.selection={from:from-2,to:from};this.onLink();}});};
  rememberSelection(){if(!this.ready)return;this.crepe.editor.action(ctx=>{const {from,to}=ctx.get(editorViewCtx).state.selection;this.selection={from,to};});}
  selectedText(){if(!this.ready)return '';return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection;return view.state.doc.textBetween(range.from,range.to);});}
  /** 插入实际 Markdown 链接，选择器中的标题与身份不会混入正文。 */
  link(url:string,label:string){if(!this.ready)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection,mark=view.state.schema.marks.link.create({href:url});const tr=view.state.tr.replaceWith(range.from,range.to,view.state.schema.text(label,[mark]));view.dispatch(tr);view.focus();});this.selection=undefined;}
  insert(markdown:string){if(this.ready){this.crepe.editor.action(insert(markdown));this.focus();}}
  format(kind:string){if(!this.ready)return;if(kind==='bold')this.crepe.editor.action(callCommand(toggleStrongCommand.key));else if(kind==='heading')this.crepe.editor.action(callCommand(wrapInHeadingCommand.key,2));else this.insert(({list:'\n- 列表项\n',quote:'\n> 引用内容\n',table:'\n| 项目 | 说明 |\n| --- | --- |\n| 名称 | 内容 |\n'} as Record<string,string>)[kind]??'');}
  undo(){if(this.ready)this.crepe.editor.action(callCommand(undoCommand.key));}
  redo(){if(this.ready)this.crepe.editor.action(callCommand(redoCommand.key));}
  focus(){if(this.ready)this.crepe.editor.action(ctx=>ctx.get(editorViewCtx).focus());}
  readonly(value:boolean){if(this.ready)this.crepe.setReadonly(value);}
  /** 保存/退出时同步取得最新正文，不能等待输入通知的防抖计时器。 */
  read(){if(this.ready){const current=this.crepe.getMarkdown();if(current!==this.baseline){this.original=preserveBlocks(this.original,current);this.baseline=current;}}return joinTail(this.original,this.tail);}
  /** 外部属性修改仅同步投影；程序更新不触发用户输入回调。 */
  replace(body:string){const part=richBodyParts(body);this.tail=part.tail;if(part.body===this.original)return;
    // 保存可能整理首尾空行；语义未变时只更新原文基准，不制造一次看不见的撤销操作。
    const unchanged=JSON.stringify(tree(part.body).children.map(key))===JSON.stringify(tree(this.original).children.map(key));
    if(!this.ready||unchanged){this.original=part.body;return;}
    this.silent=true;try{this.crepe.editor.action(replaceAll(part.body));const baseline=this.crepe.getMarkdown();this.original=part.body;this.baseline=baseline;}finally{this.silent=false;}}
  find(query:string){if(!this.ready||!query)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);let found=false;view.state.doc.descendants((node,pos)=>{if(found||!node.isText)return;const at=(node.text??'').toLocaleLowerCase().indexOf(query.toLocaleLowerCase());if(at>=0){view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos+at,pos+at+query.length)).scrollIntoView());view.focus();found=true;}});});}
  dispose(){this.disposed=true;this.root.removeEventListener('keydown',this.keydown,true);this.root.removeEventListener('keyup',this.keyup);this.observer?.disconnect();if(this.ready)void this.crepe.destroy();}
}
