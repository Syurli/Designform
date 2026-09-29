import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, nodeViewCtx, prosePluginsCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, serializerCtx } from '@milkdown/kit/core';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { hardbreakSchema, imageSchema, linkSchema, toggleEmphasisCommand, toggleStrongCommand, wrapInHeadingCommand, turnIntoTextCommand, wrapInOrderedListCommand, wrapInBulletListCommand, wrapInBlockquoteCommand } from '@milkdown/kit/preset/commonmark';
import { lift } from '@milkdown/kit/prose/commands';
import { liftListItem } from '@milkdown/kit/prose/schema-list';
import { shortcutAction,shortcutLabel,shortcutCatalog } from './input-settings';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { Fragment, Slice } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Root } from 'mdast';
import { parseSizedImage, sizedImageMarkup } from '../shared/image-markup';
import { stripBlockIds, transferBlockIds } from '../shared/document-blocks';
import { anchorHtmlView, designCodeBlockView, headingFoldingPlugin } from './rich-document-plugins';
import type { RichDesignOptions } from './rich-document-plugins';
import { DOCUMENT_DRAG_TYPE, readDocumentDrag, type DocumentDrag } from './document-drag';
import { foldTextStyles, normalizeTextStyle, type TextStyle } from '../shared/text-style';
import { textStyleMarkdownHandler, textStyleRemarkPlugin, textStyleSchema } from './rich-text-style';
import { RichTextStylePanel, textStyleIcon } from './rich-text-style-panel';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import './rich-writing.css';

const hasBlockIds=(text:string)=>/<!--\s*cewen:block\s+[\w-]+(?: parent=[\w-]+)?\s*-->/.test(text);

const tree=(text:string)=>{const root=foldTextStyles(fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}));inlineBreakRemarkPlugin()(root);return root;};
/** Crepe 的 remark 链可能把独立 HTML 图片包装进段落；先提升到块级再交给 ProseMirror。 */
const sizedImageRemarkPlugin=()=> (root:Root)=>{
  root.children=root.children.map(node=>{
    const meaningful=node.type==='paragraph'?node.children.filter(child=>child.type!=='text'||child.value.trim()):[];
    const candidate=node.type==='paragraph'&&meaningful.length===1?meaningful[0]:node;
    const image=candidate.type==='html'?parseSizedImage(candidate.value):null;
    return image?{type:'image-block',url:image.src,alt:image.alt,title:image.title,data:{widthPx:image.width},position:node.position} as unknown as Root['children'][number]:node;
  });
};
/** 最小块用同一行的 br 保存换行，标题和表格也不会被 Markdown 拆成相邻块。 */
const inlineBreakRemarkPlugin=()=> (root:Root)=>{const visit=(node:Nodes)=>{if(!('children' in node))return;node.children=node.children.flatMap(child=>{if(child.type==='html'&&/^\s*(?:<br\s*\/?>\s*)+$/i.test(child.value))return [...child.value.matchAll(/<br\s*\/?>/gi)].map(()=>({type:'break',position:child.position} as Nodes));visit(child);return [child];}) as typeof node.children;};visit(root);};
/** 功能索引沿用原有段落间距，打开再保存不得平白增添空行。 */
const joinTail=(body:string,tail:string)=>tail?body+(/\n\s*\n$/.test(body)?'':'\n\n')+tail:body;
/** 只比较语义，位置与解析器附加缓存不影响原文片段是否可以直接保留。 */
/** 行内字体与粗斜体可交换嵌套顺序；按叶文字的格式集合比较，避免等价序列误退回源码。 */
const semanticNode=(node:Nodes):unknown=>{
  if(!('children' in node))return node;
  const children:unknown[]=[],formats=new Set(['cewenTextStyle','emphasis','strong','delete','link']);
  const flatten=(child:Nodes,marks:unknown[])=>{
    if(formats.has(child.type)&&'children' in child){const format=child.type==='cewenTextStyle'?{type:child.type,style:normalizeTextStyle(child.style)}:child.type==='link'?{type:child.type,url:child.url,title:child.title}:{type:child.type};child.children.forEach(value=>flatten(value,[...marks,format]));return;}
    const normalized=semanticNode(child) as Record<string,unknown>,sorted=[...marks].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),next:Record<string,unknown>={...normalized,...(sorted.length?{formats:sorted}:{})};
    const previous=children.at(-1) as typeof next|undefined;
    // 编辑器可把同样样式的相邻文字合并，语义比较也合并它们。
    if(next.type==='text'&&previous?.type==='text'&&JSON.stringify(previous.formats)===JSON.stringify(next.formats))previous.value=String(previous.value)+String(next.value);else children.push(next);
  };
  node.children.forEach(child=>flatten(child,[]));return {...node,children};
};
const key=(node:Nodes):string=>JSON.stringify(semanticNode(node),(name,value)=>{
  if(name==='position'||name==='data'||name==='spread')return undefined;
  if(value&&typeof value==='object'&&value.type==='html'&&/^\s*<br\s*\/?>\s*$/i.test(String(value.value??'')))return {...value,type:'break',value:undefined};
  if(value&&typeof value==='object'&&value.type==='html'){const image=parseSizedImage(String(value.value??''));if(image)return {type:'html',image};}
  return typeof value==='string'?value.replace(/\r\n/g,'\n'):value;
});
export function richBodyParts(body:string){
  const nodes=tree(body).children.filter(node=>!(node.type==='html'&&/^<!-- cewen:block [A-Za-z0-9][A-Za-z0-9_-]{0,119}(?: parent=(?:root|[A-Za-z0-9][A-Za-z0-9_-]{0,119}))? -->$/.test(node.value.trim()))),at=nodes.findIndex(node=>node.type==='heading'&&node.depth===3&&node.children.length===1&&node.children[0].type==='text'&&node.children[0].value==='关联索引');
  if(at<0)return {body,tail:''};
  const tail=nodes.slice(at);
  if(tail.some(node=>node.type!=='table'&&!(node.type==='heading'&&node.children[0]?.type==='text'&&node.children[0].value==='关联索引')))return {body,tail:''};
  const offset=nodes[at].position!.start.offset!;return {body:body.slice(0,offset),tail:body.slice(offset)};
}
/** 特殊 HTML 使用源码；知识锚点与编辑器自身输出的空行标记可以无损保留。 */
export function richUnsupported(text:string){
  let reason='';
  const inspect=(node:Nodes,parent='root')=>{
    if(node.type==='html'&&!(parent==='root'&&parseSizedImage(node.value))&&!/^\s*<!--\s*cewen:block\s+[\w-]+(?: parent=[\w-]+)?\s*-->\s*$/.test(node.value)&&!/^\s*(?:<br\s*\/?>|<a\s+id=["'][\w-]+["']\s*>|<\/a>|<a\s+id=["'][\w-]+["']\s*>\s*<\/a>)\s*$/.test(node.value))reason='这份文档含有自定义 HTML，已使用源码编辑以保留原文。';
    if('children' in node)node.children.forEach(child=>inspect(child,node.type));
  };tree(text).children.forEach(node=>inspect(node));
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

/** 候选由工作台从当前项目快照提供；href 是确认后实际写入正文的相对链接。 */
export interface RichLinkCandidate { id:string; title:string; aliases:string[]; href:string; summary?:string }

/** 格式刷只复制文字样式及格式，不携带正文、链接地址或文档身份。 */
export interface TextFormatting { style:TextStyle; bold:boolean; italic:boolean; strike:boolean }

/** 块编辑器只处理正文，身份、关系索引和版本仍由策问工作台维护。 */
export class RichWriting {
  private crepe:Crepe;
  private ready=false;
  private disposed=false;
  private silent=false;
  private baseline='';
  private initialBaseline?:string;
  /** 正文已挂载但 create 尚未返回时，保存／切视图也能同步用户刚输入的文字。 */
  private pendingRead?:()=>string;
  private original:string;
  private tail:string;
  private selection?:{from:number;to:number};
  private observer?:MutationObserver;
  private candidates:RichLinkCandidate[]=[];
  private candidateBox?:HTMLElement;
  private candidateRange?:{from:number;to:number};
  private candidateIndex=0;
  private skipCandidateKeyup=false;
  private composing=false;
  private stylePanel?:RichTextStylePanel;
  private resizeHost?:HTMLElement;
  private dropCaret?:HTMLElement;
  private resolveDocumentDrop?: (item:DocumentDrag)=>{href:string;title:string}|undefined;
  private singleBlock=false;
  private disposeCaret?:()=>void;
  private uploadError(error:unknown){
    const box=this.root.closest('dialog')?.querySelector<HTMLElement>('#workbench-feedback');
    if(box){box.hidden=false;box.classList.add('error');box.textContent=`图片未能加入草稿：${error instanceof Error?error.message:'请重试或改用源码编辑。'}`;}
  }
  private mergeMarkdown(next:string){return hasBlockIds(this.original)?transferBlockIds(this.original,preserveBlocks(stripBlockIds(this.original),next)):preserveBlocks(this.original,next);}
  constructor(private root:HTMLElement,body:string,private onChange:(body:string)=>void,upload:(file:File)=>Promise<string>,resolveImage:(url:string)=>string,private onLink:()=>void,options:RichDesignOptions & {resolveDocumentDrop?:(item:DocumentDrag)=>{href:string;title:string}|undefined;singleBlock?:boolean;inlineBreaks?:boolean;contextInsertion?:boolean}={}){
    this.resolveDocumentDrop=options.resolveDocumentDrop;
    this.singleBlock=!!options.singleBlock;root.classList.toggle('rich-writing-single-block',this.singleBlock);
    // 两种原位编辑都认识自由块保存的 br；其他完整编辑器继续使用自己的默认换行序列。
    const inlineBreaks=this.singleBlock||!!options.inlineBreaks;
    root.addEventListener('dragover',this.documentDragOver,true);root.addEventListener('drop',this.documentDrop,true);root.addEventListener('dragleave',this.documentDragLeave);window.addEventListener('cewen:document-drag-end',this.clearDocumentDrop);
    const part=richBodyParts(body);this.original=part.body;this.tail=part.tail;
    // Crepe 浮层挂在传入 root 下；其主题 CSS 只匹配 .milkdown 的后代。
    // 自由块和文档段落的浮层与正文共用主题作用域，不能落回 Crepe 默认奶白色。
    root.classList.add('milkdown','rich-writing');
    // 正文原位编辑的插入统一走视图右键菜单，完整写作窗口保留自己的块工具。
    this.crepe=new Crepe({root,defaultValue:stripBlockIds(part.body),features:{[Crepe.Feature.Latex]:false,[Crepe.Feature.CodeMirror]:false,...(this.singleBlock||options.contextInsertion?{[Crepe.Feature.BlockEdit]:false}: {})},featureConfigs:{
      // 保留拖放/块间光标，停用未换算画布缩放的虚拟光标，正文由本地插件绘制。
      [Crepe.Feature.Cursor]:{virtual:false},
      [Crepe.Feature.Placeholder]:{text:this.singleBlock?'写下文字；回车换行，空白右键插入其他块。':options.contextInsertion?'写下文字，右键插入图片、章节或文档引用。':'写下设计，输入 / 插入内容，输入 [[ 引用其他 DD',mode:'doc'},
      [Crepe.Feature.ImageBlock]:{onUpload:async file=>{try{return await upload(file);}catch(error){this.uploadError(error);throw error;}},proxyDomURL:resolveImage,inlineUploadButton:'选择图片',inlineUploadPlaceholderText:'或粘贴图片链接',blockUploadButton:'选择图片',blockConfirmButton:'插入',blockCaptionPlaceholderText:'图片说明',blockUploadPlaceholderText:'或粘贴图片链接'},
      [Crepe.Feature.LinkTooltip]:{inputPlaceholder:'粘贴网址；项目文档请按 Ctrl+K'},
      [Crepe.Feature.Toolbar]:{boldLabel:'加粗',italicLabel:'斜体',strikethroughLabel:'删除线',codeLabel:'行内代码',linkLabel:'链接',buildToolbar:builder=>{
        builder.addGroup('text-style','文字样式').addItem('text-style',{icon:textStyleIcon(),label:'文字样式：字体、荧光笔与颜色',active:ctx=>{const {selection,storedMarks}=ctx.get(editorViewCtx).state;return Boolean((storedMarks??selection.$from.marks()).some(mark=>mark.type.name==='cewen_text_style'));},onRun:()=>this.textStyles()});
      }},
      [Crepe.Feature.BlockEdit]:{textGroup:{label:'正文',text:{label:'段落'},h1:{label:'一级标题'},h2:{label:'二级标题'},h3:{label:'三级标题'},h4:{label:'四级标题'},h5:{label:'五级标题'},h6:{label:'六级标题'},quote:{label:'引用'},divider:{label:'分隔线'}},listGroup:{label:'列表',bulletList:{label:'项目列表'},orderedList:{label:'编号列表'},taskList:{label:'待办清单'}},advancedGroup:{label:'插入',image:{label:'图片'},table:{label:'表格'},codeBlock:{label:'代码块'},math:null},slashMenu:{root},blockHandle:{root}},
    }});
    // 图片块保留真实 alt；缩放写入公开 HTML 像素宽度，不再把倍率污染到 ![alt]。
    this.crepe.editor.use(textStyleSchema);
    this.crepe.editor.config(ctx=>{
      // 链接右边界不自动继承引用；新输入、空格和新段落默认恢复普通正文。
      ctx.update(linkSchema.key,previous=>current=>({...previous(current),inclusive:false}));
      ctx.update(prosePluginsCtx,previous=>[new Plugin({props:{handleTextInput:(view,from,to,text)=>{
        if(!/^\s+$/.test(text)||view.composing)return false;const marks=view.state.storedMarks??view.state.doc.resolve(from).marks();if(!marks.some(mark=>mark.type.name==='link'))return false;
        const plain=marks.filter(mark=>mark.type.name!=='link');view.dispatch(view.state.tr.replaceWith(from,to,view.state.schema.text(text,plain)).setStoredMarks(plain));return true;
      }},view:()=>({update:()=>window.dispatchEvent(new Event('cewen:paragraph-selection'))})}),...previous]);
      ctx.update(remarkPluginsCtx,previous=>[...previous,{plugin:sizedImageRemarkPlugin,options:{}},{plugin:textStyleRemarkPlugin,options:{}},...(inlineBreaks?[{plugin:inlineBreakRemarkPlugin,options:{}}]:[])]);
      ctx.update(remarkStringifyOptionsCtx,previous=>({...previous,handlers:{...previous.handlers,cewenTextStyle:textStyleMarkdownHandler}}));
      if(inlineBreaks)ctx.update(hardbreakSchema.key,previous=>current=>({...previous(current),toMarkdown:{match:node=>node.type.name==='hardbreak',runner:(state,node)=>{if(node.attrs.isInline)state.addNode('text',undefined,'\n');else state.addNode('html',undefined,'<br>');}}}));
      if(this.singleBlock)ctx.update(prosePluginsCtx,previous=>[new Plugin({props:{
        // 自由文本块的回车是段内换行，代码块则保留真实换行字符。
        handleKeyDown:(view,event)=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229||!view.editable)return false;const {state}=view;let list=false;for(let depth=state.selection.$from.depth;depth>0;depth--)if(state.selection.$from.node(depth).type.name==='list_item')list=true;if(list&&!event.shiftKey)return false;event.preventDefault();const marks=(state.storedMarks??state.selection.$from.marks()).filter(mark=>mark.type.name!=='link');if(state.selection.$from.parent.type.spec.code)view.dispatch(state.tr.insertText('\n'));else if(state.schema.nodes.hardbreak)view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardbreak.create(),false).ensureMarks(marks));return true;},
        // 多段粘贴压成当前块内的换行，保留文字 marks，拒绝在块内嵌入图片/模块/表格。
        transformPasted:(slice,view)=>{for(let depth=view.state.selection.$from.depth;depth>0;depth--)if(view.state.selection.$from.node(depth).type.name==='list_item')return slice;const nodes:import('@milkdown/kit/prose/model').Node[]=[],lineBreak=view.state.schema.nodes.hardbreak;const append=(node:import('@milkdown/kit/prose/model').Node)=>{if(node.isText){nodes.push(node);return;}if(node.type===lineBreak){nodes.push(node);return;}if(node.isLeaf)return;const before=nodes.length;node.forEach(child=>{if(child.isBlock&&nodes.length>before&&lineBreak&&nodes.at(-1)?.type!==lineBreak)nodes.push(lineBreak.create());append(child);});};slice.content.forEach((node,index)=>{if(index&&lineBreak&&nodes.length&&nodes.at(-1)?.type!==lineBreak)nodes.push(lineBreak.create());append(node);});return new Slice(Fragment.fromArray(nodes),0,0);},
      },filterTransaction:(transaction,state)=>{
        if(!transaction.docChanged)return true;let permitted=true;
        // 列表继续、退出和段落属性转换都属于正文编辑；媒体原子仍走明确的插入入口。
        const allowed=new Set<string>(['paragraph','heading','ordered_list','bullet_list','blockquote']);state.doc.forEach(node=>allowed.add(node.type.name));transaction.doc.forEach(node=>{if(!allowed.has(node.type.name))permitted=false;});
        // 输入规则也不能绕过菜单限制添加行内图片/HTML 原子；已存在于混合正文的原子继续保留。
        const count=(doc:import('@milkdown/kit/prose/model').Node)=>{const counts=new Map<string,number>();doc.descendants(node=>{if(node.isAtom&&!node.isText&&node.type.name!=='hardbreak')counts.set(node.type.name,(counts.get(node.type.name)??0)+1);});return counts;},before=count(state.doc),after=count(transaction.doc);for(const [name,amount] of after)if(amount>(before.get(name)??0))permitted=false;
        return permitted;
      }}),...previous]);
      // 折叠使用装饰层；对白和色板 NodeView 只改变呈现，保存仍修改原代码块。
      ctx.update(prosePluginsCtx,previous=>[...previous,headingFoldingPlugin(),this.caretPlugin(),new Plugin({view:view=>{
        // 在首个用户事件前记录初始序列；create 的异步收尾不能把早输入当成初始正文。
        const serialize=ctx.get(serializerCtx);this.initialBaseline=serialize(view.state.doc);this.pendingRead=()=>serialize(view.state.doc);
        return {destroy:()=>{this.pendingRead=undefined;}};
      }})]);
      ctx.update(nodeViewCtx,previous=>[...previous,['code_block',designCodeBlockView(options)] as [string,ReturnType<typeof designCodeBlockView>],['html',anchorHtmlView()] as [string,ReturnType<typeof anchorHtmlView>]]);
      ctx.update(imageBlockSchema.key,previous=>current=>{
        const schema=previous(current);
        return {...schema,
          attrs:{...schema.attrs,alt:{default:'',validate:'string'},widthPx:{default:0,validate:'number'}},
          parseDOM:[{tag:'img[data-type="image-block"]',getAttrs:dom=>({src:dom.getAttribute('src')||'',caption:dom.getAttribute('caption')||'',alt:dom.getAttribute('alt')||'',ratio:Number(dom.getAttribute('ratio')??1),widthPx:Number(dom.getAttribute('widthPx')??0)})}],
          parseMarkdown:{match:({type})=>type==='image-block',runner:(state,node,type)=>state.addNode(type,{src:String(node.url??''),caption:String(node.title??''),alt:String(node.alt??''),ratio:1,widthPx:Number((node.data as {widthPx?:number}|undefined)?.widthPx??0)})},
          toMarkdown:{match:node=>node.type.name==='image-block',runner:(state,node)=>{
            const width=Number(node.attrs.widthPx);
            if(Number.isFinite(width)&&width>0){state.addNode('html',undefined,sizedImageMarkup({src:String(node.attrs.src),alt:String(node.attrs.alt??''),title:String(node.attrs.caption??''),width}));return;}
            state.openNode('paragraph');state.addNode('image',undefined,undefined,{url:node.attrs.src,alt:node.attrs.alt,title:node.attrs.caption||null});state.closeNode();
          }},
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
      const body=this.mergeMarkdown(markdown);
      this.onChange(joinTail(body,this.tail));
      this.original=body;this.baseline=markdown;
    }));
    root.addEventListener('keydown',this.keydown,true);
    root.addEventListener('keyup',this.keyup);
    root.addEventListener('input',this.onInput);
    root.addEventListener('compositionend',this.onCompositionEnd);
    root.addEventListener('compositionstart',this.onCompositionStart);
    root.addEventListener('focusout',this.onFocusOut);
    root.addEventListener('mouseup',this.onSelectionMove);
    document.addEventListener('selectionchange',this.onSelectionMove);
    root.addEventListener('pointerdown',this.onImagePointerDown,true);
    root.addEventListener('pointerover',this.onImageHandleHover);
    root.addEventListener('load',this.onImageLoad,true);
    window.addEventListener('pointerup',this.onImagePointerUp);
  }
  async create(){
    // 初始化期间 read() 可以先同步输入，初始结构核对仍使用创建前的原文。
    const initial=this.original;
    await this.crepe.create();if(this.disposed){await this.crepe.destroy();return;}
    const current=this.crepe.getMarkdown();this.baseline=this.initialBaseline??current;
    const semantic=(text:string)=>JSON.stringify(tree(stripBlockIds(text)).children.map(key));
    if(semantic(initial)!==semantic(this.baseline)){this.ready=true;throw new Error('此文档的块结构无法无损往返，请保留源码编辑。');}
    this.ready=true;
    // 正文挂载到 create 返回之间的输入要同步草稿，不能被防抖回调和初始基准吞掉。
    if(current!==this.baseline){const body=this.mergeMarkdown(current);this.original=body;this.baseline=current;this.onChange(joinTail(body,this.tail));}
    this.root.querySelector('.ProseMirror')?.setAttribute('aria-label','策划正文');this.root.querySelector('.ProseMirror')?.setAttribute('role','textbox');this.root.querySelector('.ProseMirror')?.setAttribute('aria-multiline','true');this.root.querySelectorAll<HTMLElement>('.image-resize-handle').forEach(handle=>handle.title='拖动调整图片大小');this.root.querySelectorAll<HTMLImageElement>('.milkdown-image-block img').forEach(image=>{if(image.complete&&image.naturalWidth)this.onImageLoad({target:image} as unknown as Event);});
  }
  /** 光标只取浏览器的实际文字坐标，顶层固定层不经过画布 scale，也不占据段落中的 widget 位置。 */
  private caretPlugin(){return new Plugin({view:(view:EditorView)=>{
    if(this.disposed)return {};
    const doc=view.dom.ownerDocument,win=doc.defaultView??window,cursor=doc.createElement('span');
    // 不支持顶层 popover 的环境保留原生光标；不能退回受 transform 影响的固定定位。
    if(typeof cursor.showPopover!=='function')return {};
    cursor.className='rich-text-caret';cursor.setAttribute('popover','manual');cursor.setAttribute('aria-hidden','true');this.root.append(cursor);
    let frame=0,closed=false,visible=false,geometry='';
    const hide=()=>{view.dom.classList.remove('rich-caret-active');if(visible){cursor.hidePopover();visible=false;}geometry='';};
    const update=()=>{
      frame=0;
      // 输入法使用浏览器原生光标，避免替代层干扰候选窗及组合文字的临时选区。
      if(closed||this.disposed||view.isDestroyed||!view.dom.isConnected||!cursor.isConnected||view.composing||this.composing||!view.editable||!view.hasFocus()||!(view.state.selection instanceof TextSelection)||!view.state.selection.empty){hide();return;}
      const selection=doc.getSelection();let rect:Pick<DOMRect,'left'|'top'|'bottom'>|undefined;
      if(selection?.rangeCount){const range=selection.getRangeAt(0);if(range.collapsed&&view.dom.contains(range.startContainer)){const rects=range.getClientRects();const candidate=rects[rects.length-1];if(candidate?.height)rect=candidate;}}
      if(!rect){try{rect=view.coordsAtPos(view.state.selection.head);}catch{hide();return;}}
      // 顶层层不继承滚动裁剪，按正文沿途真实裁剪区域收敛，防止光标浮到标题栏或卡片之外。
      let left=0,top=0,right=win.innerWidth,bottom=win.innerHeight;
      for(let node:HTMLElement|null=view.dom;node&&node!==doc.body;node=node.parentElement){const css=win.getComputedStyle(node),bounds=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}}
      const y=Math.max(rect.top,top),end=Math.min(rect.bottom,bottom);if(rect.left<left||rect.left>right||end<=y||right<=left){hide();return;}
      // 自适应文本块的末字贴近裁剪边缘时，将光标整体收进可见区，避免被裁成接近 0px 的细线。
      const width=Math.min(2,right-left),x=Math.max(left,Math.min(rect.left,right-width));
      const next=`${x}:${y}:${end}`;Object.assign(cursor.style,{left:`${x}px`,top:`${y}px`,height:`${end-y}px`,width:`${width}px`});
      if(!visible){cursor.showPopover();visible=true;}view.dom.classList.add('rich-caret-active');
      // 每次移动/输入从亮态重新闪烁，不用强制重排正文，也不改变字体或选区。
      if(next!==geometry)for(const animation of cursor.getAnimations())animation.currentTime=0;geometry=next;
    };
    const schedule=()=>{if(!closed&&!frame)frame=win.requestAnimationFrame(update);};
    const startComposition=()=>{hide();schedule();};
    doc.addEventListener('selectionchange',schedule);doc.addEventListener('scroll',schedule,true);doc.addEventListener('wheel',schedule,true);win.addEventListener('resize',schedule);
    view.dom.addEventListener('focus',schedule);view.dom.addEventListener('blur',hide);view.dom.addEventListener('compositionstart',startComposition);view.dom.addEventListener('compositionend',schedule);
    const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(schedule):undefined;resize?.observe(view.dom);
    // 画布平移/缩放只改祖先 style，未必触发编辑器 update 或 resize，必须单独跟踪。
    const transforms=new win.MutationObserver(schedule);for(let node=view.dom.parentElement;node;node=node.parentElement)transforms.observe(node,{attributes:true,attributeFilter:['style','class']});
    const destroy=()=>{if(closed)return;closed=true;if(frame)win.cancelAnimationFrame(frame);hide();cursor.remove();resize?.disconnect();transforms.disconnect();doc.removeEventListener('selectionchange',schedule);doc.removeEventListener('scroll',schedule,true);doc.removeEventListener('wheel',schedule,true);win.removeEventListener('resize',schedule);view.dom.removeEventListener('focus',schedule);view.dom.removeEventListener('blur',hide);view.dom.removeEventListener('compositionstart',startComposition);view.dom.removeEventListener('compositionend',schedule);if(this.disposeCaret===destroy)this.disposeCaret=undefined;};
    this.disposeCaret=destroy;schedule();return {update:schedule,destroy};
  }});}
  private keydown=(event:KeyboardEvent)=>{
    if(event.isComposing||this.composing||event.keyCode===229)return;
    const action=shortcutAction(event);
    // 自定义组合键直接操作当前 ProseMirror 选区；默认系统编辑键保留其原生输入路径。
    if(action&&['undo','redo','copy','cut','paste','selectAll','delete'].includes(action)&&shortcutLabel(action)!==shortcutCatalog[action][1]){
      event.preventDefault();event.stopPropagation();
      if(action==='undo')this.undo();else if(action==='redo')this.redo();
      else this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),state=view.state,{from,to}=state.selection;
        if(action==='selectAll'){view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,0,state.doc.content.size)));return;}
        if(action==='copy'||action==='cut'){void navigator.clipboard.writeText(state.doc.textBetween(from,to,'\n')).then(()=>{if(action==='cut'&&this.ready&&!this.disposed&&view.editable)view.dispatch(view.state.tr.deleteSelection());}).catch(error=>this.uploadError(error));return;}
        if(action==='paste'){void navigator.clipboard.readText().then(text=>{if(this.ready&&!this.disposed&&view.editable)view.dispatch(view.state.tr.insertText(text));}).catch(error=>this.uploadError(error));return;}
        if(action==='delete'&&view.editable){if(from!==to)view.dispatch(state.tr.deleteSelection());else{const length=Array.from(state.selection.$from.parent.textContent.slice(state.selection.$from.parentOffset))[0]?.length??0;if(length)view.dispatch(state.tr.delete(from,from+length));}}
      });return;
    }
    if(this.candidateRange&&this.candidateBox&&!this.candidateBox.hidden){
      const buttons=[...this.candidateBox.querySelectorAll<HTMLButtonElement>('button[data-candidate]')];
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.candidateIndex=(this.candidateIndex+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;this.markCandidate();return;}
      if(event.key==='Enter'&&buttons.length){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.chooseCandidate(Number(buttons[this.candidateIndex].dataset.candidate));return;}
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.closeCandidates();return;}
    }
    if(shortcutAction(event)==='link'){event.preventDefault();event.stopPropagation();this.closeCandidates();this.rememberSelection();this.onLink();}
  };
  private keyup=(event:KeyboardEvent)=>{if(this.skipCandidateKeyup){this.skipCandidateKeyup=false;return;}if(!event.isComposing&&!this.composing)this.updateCandidates();};
  private onInput=(event:Event)=>{if(!this.composing&&(!(event instanceof InputEvent)||!event.isComposing))this.updateCandidates();};
  private onCompositionStart=()=>{this.composing=true;this.closeCandidates();};
  private onCompositionEnd=()=>{this.composing=false;queueMicrotask(()=>this.updateCandidates());};
  private onFocusOut=()=>{queueMicrotask(()=>{if(!this.root.contains(document.activeElement))this.closeCandidates();});};
  private onSelectionMove=()=>{queueMicrotask(()=>this.updateCandidates());};
  /** Crepe 的 ratio 是相对图片适配后高度的倍率；保存展示宽度才能让公开 HTML 准确表达大小。 */
  private onImagePointerDown=(event:PointerEvent)=>{this.resizeHost=event.target instanceof Element&&event.target.closest('.image-resize-handle')?event.target.closest<HTMLElement>('.milkdown-image-block')??undefined:undefined;};
  private onImageHandleHover=(event:PointerEvent)=>{const handle=event.target instanceof Element?event.target.closest<HTMLElement>('.image-resize-handle'):null;if(handle)handle.title='拖动调整图片大小';};
  private onImagePointerUp=()=>{const host=this.resizeHost;if(!host)return;this.resizeHost=undefined;queueMicrotask(()=>this.captureImageWidths(host));};
  private captureImageWidths(resizedHost?:HTMLElement){
    if(!this.ready||this.disposed)return;
    this.crepe.editor.action(ctx=>{
      const view=ctx.get(editorViewCtx);let transaction=view.state.tr;
      view.state.doc.descendants((node,pos)=>{
        if(node.type.name!=='image-block'||(!resizedHost&&Number(node.attrs.widthPx)>0)||(!resizedHost&&Number(node.attrs.ratio)===1))return;
        const host=view.nodeDOM(pos);if(!(host instanceof HTMLElement)||resizedHost&&host!==resizedHost)return;
        const image=host.querySelector('img');if(!image||!image.complete)return;
        const width=Math.round(image.getBoundingClientRect().width);
        if(width>0&&width!==Number(node.attrs.widthPx))transaction=transaction.setNodeAttribute(pos,'widthPx',width);
      });
      if(transaction.docChanged)view.dispatch(transaction);
    });
  }
  /** 读取 HTML 像素宽后等待图片天然尺寸可用，再换算为 Crepe 当前容器下的倍率。 */
  private onImageLoad=(event:Event)=>{
    const image=event.target;if(!(image instanceof HTMLImageElement)||!image.closest('.milkdown-image-block'))return;
    queueMicrotask(()=>{
      if(!this.ready||this.disposed||!image.isConnected||!image.naturalWidth||!image.naturalHeight)return;
      this.crepe.editor.action(ctx=>{
        const view=ctx.get(editorViewCtx);let transaction=view.state.tr;
        view.state.doc.descendants((node,pos)=>{
          if(node.type.name!=='image-block'||!Number(node.attrs.widthPx))return;
          const host=view.nodeDOM(pos);if(!(host instanceof HTMLElement)||!host.contains(image))return;
          const hostWidth=host.getBoundingClientRect().width,baseWidth=Math.min(image.naturalWidth,hostWidth);
          if(!baseWidth)return;
          const displayWidth=Math.min(Number(node.attrs.widthPx),hostWidth),ratio=Number((displayWidth/baseWidth).toFixed(4));
          const baseHeight=baseWidth*image.naturalHeight/image.naturalWidth;
          image.dataset.origin=baseHeight.toFixed(2);image.dataset.height=(baseHeight*ratio).toFixed(2);image.style.height=`${baseHeight*ratio}px`;
          if(Math.abs(Number(node.attrs.ratio)-ratio)>0.0001)transaction=transaction.setNodeAttribute(pos,'ratio',ratio);
        });
        if(transaction.docChanged)view.dispatch(transaction.setMeta('addToHistory',false));
      });
    });
  };
  /** 项目刷新后更新候选；允许标题与用户别名同时匹配。 */
  setLinkCandidates(candidates:RichLinkCandidate[]){this.candidates=candidates.filter(item=>item.title&&item.href);this.updateCandidates();}
  private updateCandidates(){
    if(!this.ready||this.disposed||this.composing||!this.candidates.length)return this.closeCandidates();
    this.crepe.editor.action(ctx=>{
      const view=ctx.get(editorViewCtx),selection=view.state.selection;
      if(!selection.empty||!view.hasFocus()||!view.editable)return this.closeCandidates();
      const $from=selection.$from;
      if(!['paragraph','heading'].includes($from.parent.type.name)||$from.marks().some(mark=>mark.type.name==='link'||mark.type.name==='inlineCode'))return this.closeCandidates();
      const line=$from.parent.textBetween(0,$from.parentOffset);
      const opener=line.lastIndexOf('[['),explicit=opener>=0&&!line.slice(opener+2).includes(']');
      let query='',token='';
      if(explicit){query=line.slice(opener+2);if(query.length>40||/[\n\r]/.test(query))return this.closeCandidates();token=line.slice(opener);}
      else{
        // 中文正文没有空格边界：寻找候选名称的最长前缀后缀，只替换实际输入的尾段。
        for(const item of this.candidates)for(const name of [item.title,...item.aliases]){
          const limit=Math.min(line.length,name.length,40);
          for(let size=limit;size>=2;size--){const tail=line.slice(-size);if(!name.toLocaleLowerCase().startsWith(tail.toLocaleLowerCase()))continue;
            if(/^[A-Za-z0-9_]/.test(tail)&&/[A-Za-z0-9_]$/.test(line.slice(0,-size)))continue;
            if(size>query.length){query=tail;token=tail;}break;
          }
        }
      }
      if(!token)return this.closeCandidates();
      const normalized=query.toLocaleLowerCase(),items=this.candidates.filter(item=>!query||[item.title,...item.aliases].some(name=>name.toLocaleLowerCase().startsWith(normalized))).slice(0,8);
      if(!items.length)return this.closeCandidates();
      this.candidateRange={from:selection.from-token.length,to:selection.from};
      const box=this.candidateBox??document.createElement('div');this.candidateBox=box;box.className='rich-link-candidates';box.setAttribute('role','listbox');box.setAttribute('aria-label','文档链接候选');
      box.replaceChildren();this.candidateIndex=0;box.id ||= `rich-link-candidates-${crypto.randomUUID()}`;
      items.forEach((item,index)=>{const button=document.createElement('button');button.type='button';button.dataset.candidate=String(index);button.id=`${box.id}-option-${index}`;button.setAttribute('role','option');const name=document.createElement('strong');name.textContent=item.title;button.append(name);if(item.summary){const detail=document.createElement('small');detail.textContent=item.summary.slice(0,100);button.append(detail);}button.addEventListener('pointerdown',event=>event.preventDefault());button.addEventListener('click',()=>this.chooseCandidate(index));box.append(button);});
      this.visibleCandidates=items;this.markCandidate();
      if(!box.isConnected)this.root.append(box);box.hidden=false;
      view.dom.setAttribute('aria-autocomplete','list');view.dom.setAttribute('aria-expanded','true');view.dom.setAttribute('aria-controls',box.id);
      const caret=view.coordsAtPos(selection.from),rect=this.root.getBoundingClientRect();box.style.left=`${Math.max(8,Math.min(caret.left-rect.left,this.root.clientWidth-340))}px`;box.style.top=`${caret.bottom-rect.top+8}px`;
    });
  }
  private visibleCandidates:RichLinkCandidate[]=[];
  private markCandidate(){this.candidateBox?.querySelectorAll<HTMLButtonElement>('button[data-candidate]').forEach((button,index)=>{button.setAttribute('aria-selected',String(index===this.candidateIndex));if(index===this.candidateIndex)this.root.querySelector('.ProseMirror')?.setAttribute('aria-activedescendant',button.id);});}
  private chooseCandidate(index:number){const item=this.visibleCandidates[index],range=this.candidateRange;if(!item||!range)return;this.closeCandidates();this.selection=range;this.link(item.href,item.title);}
  private closeCandidates(){this.candidateRange=undefined;this.visibleCandidates=[];this.candidateBox?.remove();const editor=this.root.querySelector('.ProseMirror');editor?.removeAttribute('aria-expanded');editor?.removeAttribute('aria-controls');editor?.removeAttribute('aria-activedescendant');}
  rememberSelection(){if(!this.ready)return;this.crepe.editor.action(ctx=>{const {from,to}=ctx.get(editorViewCtx).state.selection;this.selection={from,to};});}
  /** 右侧工具页的桥接名称与画布一致，保留选区后工具可以正常获取焦点。 */
  rememberTextSelection(){this.rememberSelection();}
  private restoreTextSelection(){if(!this.ready||this.disposed)return false;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);if(this.selection){const limit=view.state.doc.content.size;view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,Math.min(this.selection.from,limit),Math.min(this.selection.to,limit))));}});return true;}
  formatText(kind:'bold'|'italic'|'style'):boolean{if(!this.restoreTextSelection())return false;this.format(kind);return true;}
  /** 获取光标所在的真实段落属性，工具下拉框不从视觉字号猜测标题级别。 */
  paragraphType():string{if(!this.ready||this.disposed)return 'paragraph';return this.crepe.editor.action(ctx=>{const from=ctx.get(editorViewCtx).state.selection.$from;for(let depth=from.depth;depth>0;depth--){const node=from.node(depth);if(['ordered_list','bullet_list','blockquote'].includes(node.type.name))return node.type.name;}return from.parent.type.name==='heading'?`heading:${from.parent.attrs.level}`:'paragraph';});}
  /** 转换已有内容而非插入占位；退出列表/引用时先提升段落，保留原文字与 marks。 */
  formatParagraph(kind:string):boolean{
    if(!this.restoreTextSelection())return false;const before=this.paragraphType();
    // 属性改变后不继续沿用旧段落的字号采样；按当前正文基准显示新的标题级别。
    const base=Number.parseFloat(getComputedStyle(this.root).fontSize)||16,level=Number(kind.split(':')[1]);
    const size=kind.startsWith('heading:')?`${base*([2,1.55,1.3,1.15,1.05,1][level-1]??1)}px`:`${base}px`,tag=kind.startsWith('heading:')?`h${level}`:'p';
    this.root.style.setProperty('--inline-reading-font-size',size);
    this.root.style.setProperty('--inline-reading-font-weight',kind.startsWith('heading:')?'650':'400');
    this.root.style.setProperty(`--inline-${tag}-font-size`,size);this.root.style.setProperty(`--inline-${tag}-font-weight`,kind.startsWith('heading:')?'650':'400');
    this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);if(!view.editable)return;if(before==='ordered_list'||before==='bullet_list')liftListItem(view.state.schema.nodes.list_item)(view.state,view.dispatch);else if(before==='blockquote')lift(view.state,view.dispatch);});
    if(kind.startsWith('heading:'))this.crepe.editor.action(callCommand(wrapInHeadingCommand.key,Number(kind.split(':')[1])));
    else if(kind==='ordered_list')this.crepe.editor.action(callCommand(wrapInOrderedListCommand.key));
    else if(kind==='bullet_list')this.crepe.editor.action(callCommand(wrapInBulletListCommand.key));
    else if(kind==='blockquote')this.crepe.editor.action(callCommand(wrapInBlockquoteCommand.key));
    else this.crepe.editor.action(callCommand(turnIntoTextCommand.key));
    this.selection=undefined;this.focus();return true;
  }
  highlightText(color:string):boolean{if(!this.restoreTextSelection())return false;const highlight=normalizeTextStyle({highlight:color}).highlight;if(!highlight)return false;this.applyTextStyle({highlight});return true;}
  /** 初始主题字体与颜色也可被格式刷复制；独立文字 mark 优先于计算样式。 */
  copyTextFormatting():TextFormatting|undefined{
    if(!this.ready||this.disposed)return;return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection;let marks=view.state.storedMarks??view.state.doc.resolve(range.from).marks();if(range.from!==range.to){let found=false;view.state.doc.nodesBetween(range.from,range.to,node=>{if(!found&&node.isText){marks=node.marks;found=true;}});}
      const dom=view.domAtPos(range.from).node,element=dom instanceof HTMLElement?dom:dom.parentElement,css=element?getComputedStyle(element):getComputedStyle(view.dom),style=normalizeTextStyle(marks.find(mark=>mark.type.name==='cewen_text_style')?.attrs??{});
      const rgb=/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css.color),family=/^\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/.exec(css.fontFamily);if(!style.fontFamily)style.fontFamily=normalizeTextStyle({fontFamily:family?.[1]??family?.[2]??family?.[3]??null}).fontFamily;if(!style.color&&rgb)style.color='#'+rgb.slice(1,4).map(value=>Math.min(255,Number(value)).toString(16).padStart(2,'0')).join('');
      return {style,bold:marks.some(mark=>mark.type.name==='strong')||Number(css.fontWeight)>=600,italic:marks.some(mark=>mark.type.name==='emphasis')||/italic|oblique/.test(css.fontStyle),strike:marks.some(mark=>mark.type.name==='strike_through')||css.textDecorationLine.includes('line-through')};
    });
  }
  /** 只改选中文字的四类格式，其他 mark（尤其链接）及文字内容原样保留。 */
  applyTextFormatting(format:TextFormatting):boolean{
    if(!this.restoreTextSelection())return false;return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);if(!view.editable)return false;const {state}=view,range=this.selection??state.selection,from=Math.min(range.from,state.doc.content.size),to=Math.min(range.to,state.doc.content.size),style=normalizeTextStyle(format.style),types=state.schema.marks,tr=state.tr;
      const replacements=[{type:types.cewen_text_style,enabled:Object.values(style).some(Boolean),attrs:style},{type:types.strong,enabled:format.bold},{type:types.emphasis,enabled:format.italic},{type:types.strike_through,enabled:format.strike}];
      if(from===to){let marks=[...(state.storedMarks??state.doc.resolve(from).marks())];for(const item of replacements){if(!item.type)continue;marks=marks.filter(mark=>mark.type!==item.type);if(item.enabled)marks.push(item.type.create(item.attrs));}tr.setStoredMarks(marks);}else state.doc.nodesBetween(from,to,(node,pos)=>{if(!node.isText)return;const start=Math.max(from,pos),end=Math.min(to,pos+node.nodeSize);for(const item of replacements){if(!item.type)continue;tr.removeMark(start,end,item.type);if(item.enabled)tr.addMark(start,end,item.type.create(item.attrs));}});
      view.dispatch(tr);return true;
    });
  }
  /** 文档拖放插入标题与分类颜色；调用者已核对身份，正文不复制来源内容。 */
  linkColored(ref:{href:string;title:string;color:string},point?:{left:number;top:number}):boolean{
    if(!this.ready||this.disposed)return false;return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);if(!view.editable)return false;const {state}=view,hit=point?view.posAtCoords(point):undefined,tr=state.tr;if(point&&!hit)return false;if(hit)tr.setSelection(TextSelection.near(state.doc.resolve(hit.pos)));const marks=[state.schema.marks.link.create({href:ref.href})],color=normalizeTextStyle({color:ref.color}).color;if(color&&state.schema.marks.cewen_text_style)marks.push(state.schema.marks.cewen_text_style.create({color}));tr.replaceSelectionWith(state.schema.text(ref.title,marks),false);view.dispatch(tr.scrollIntoView());this.selection=undefined;view.focus();return true;});
  }
  /** 只处理文档身份拖放；图片上传、块排序继续走编辑器自己的事件。 */
  private documentDragOver=(event:DragEvent)=>{
    if(!this.ready||!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE))return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';
    this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),hit=view.posAtCoords({left:event.clientX,top:event.clientY});if(!hit)return;
      const cursor=TextSelection.near(view.state.doc.resolve(hit.pos)),rect=view.coordsAtPos(cursor.from);
      if(!this.dropCaret){this.dropCaret=document.createElement('span');this.dropCaret.className='document-link-drop-caret';this.root.append(this.dropCaret);}
      Object.assign(this.dropCaret.style,{left:`${rect.left}px`,top:`${rect.top}px`,height:`${Math.max(20,rect.bottom-rect.top)}px`});this.root.classList.add('document-link-dragover');
    });
  };
  private documentDrop=(event:DragEvent)=>{
    if(!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE))return;
    event.preventDefault();event.stopPropagation();this.clearDocumentDrop();if(!this.ready)return;
    const payload=readDocumentDrag(event.dataTransfer),link=payload&&this.resolveDocumentDrop?.(payload);if(!link)return;
    this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),hit=view.posAtCoords({left:event.clientX,top:event.clientY});if(!hit)return;
      const tr=view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos)));tr.replaceSelectionWith(view.state.schema.text(link.title,[view.state.schema.marks.link.create({href:link.href})]),false);view.dispatch(tr.scrollIntoView());view.focus();this.selection=undefined;
    });
  };
  private documentDragLeave=(event:DragEvent)=>{if(!this.root.contains(event.relatedTarget as Node|null))this.clearDocumentDrop();};
  private clearDocumentDrop=()=>{this.dropCaret?.remove();this.dropCaret=undefined;this.root.classList.remove('document-link-dragover');};
  selectedText(){if(!this.ready)return '';return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection;return view.state.doc.textBetween(range.from,range.to);});}
  /** 插入实际 Markdown 链接，选择器中的标题与身份不会混入正文。 */
  link(url:string,label:string){if(!this.ready)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection,mark=view.state.schema.marks.link.create({href:url});const tr=view.state.tr.replaceWith(range.from,range.to,view.state.schema.text(label,[mark]));view.dispatch(tr);view.focus();});this.selection=undefined;}
  insert(markdown:string){if(this.ready){this.crepe.editor.action(insert(markdown));this.focus();}}
  format(kind:string){if(!this.ready)return;if(kind==='bold')this.crepe.editor.action(callCommand(toggleStrongCommand.key));else if(kind==='italic')this.crepe.editor.action(callCommand(toggleEmphasisCommand.key));else if(kind==='style')this.textStyles();else if(kind==='heading')this.crepe.editor.action(callCommand(wrapInHeadingCommand.key,2));else this.insert(({list:'\n- 列表项\n',quote:'\n> 引用内容\n',table:'\n| 项目 | 说明 |\n| --- | --- |\n| 名称 | 内容 |\n'} as Record<string,string>)[kind]??'');}
  /** 浮框可以离开正文焦点；应用样式始终定位原选区，保留其中每段的其他样式与标记。 */
  textStyles(){
    if(!this.ready||this.disposed)return;this.stylePanel?.dispose();this.rememberSelection();
    this.crepe.editor.action(ctx=>{
      const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection,type=view.state.schema.marks.cewen_text_style;
      if(!view.editable||!type)return;
      const marks=view.state.storedMarks??view.state.doc.resolve(range.from).marks();let initial=marks.find(mark=>mark.type===type)?.attrs;
      if(range.from!==range.to)view.state.doc.nodesBetween(range.from,range.to,node=>{if(initial||!node.isText)return;initial=node.marks.find(mark=>mark.type===type)?.attrs;});
      const toolbar=this.root.querySelector<HTMLElement>('.milkdown-toolbar'),bounds=toolbar?.getBoundingClientRect(),anchor=bounds&&bounds.width?bounds:this.root.getBoundingClientRect();
      this.stylePanel=new RichTextStylePanel(anchor,normalizeTextStyle(initial??{}),view.state.doc.textBetween(range.from,range.to),patch=>this.applyTextStyle(patch),restore=>{
        this.stylePanel=undefined;if(restore&&this.ready&&!this.disposed)this.crepe.editor.action(current=>{const target=current.get(editorViewCtx);if(this.selection){const limit=target.state.doc.content.size;target.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc,Math.min(this.selection.from,limit),Math.min(this.selection.to,limit))));}target.focus();});this.selection=undefined;
      });
    });
  }
  private applyTextStyle(patch:Partial<TextStyle>){if(!this.ready||this.disposed)return;this.crepe.editor.action(ctx=>{
    const view=ctx.get(editorViewCtx);if(!view.editable)return;const state=view.state,type=state.schema.marks.cewen_text_style,range=this.selection??state.selection;
    const from=Math.min(range.from,state.doc.content.size),to=Math.min(range.to,state.doc.content.size),tr=state.tr;
    if(from===to){const marks=state.storedMarks??state.doc.resolve(from).marks(),style=normalizeTextStyle({...marks.find(mark=>mark.type===type)?.attrs,...patch});const next=marks.filter(mark=>mark.type!==type);if(Object.values(style).some(Boolean))next.push(type.create(style));tr.setStoredMarks(next);}
    else state.doc.nodesBetween(from,to,(node,pos)=>{if(!node.isText)return;const start=Math.max(from,pos),end=Math.min(to,pos+node.nodeSize),style=normalizeTextStyle({...node.marks.find(mark=>mark.type===type)?.attrs,...patch});tr.removeMark(start,end,type);if(Object.values(style).some(Boolean))tr.addMark(start,end,type.create(style));});
    view.dispatch(tr);
  });}
  undo(){if(this.ready)this.crepe.editor.action(callCommand(undoCommand.key));}
  redo(){if(this.ready)this.crepe.editor.action(callCommand(redoCommand.key));}
  /** 块内首次单击后，把光标定位到实际点击的文字位置。 */
  focusAt(point:{left:number;top:number}){if(this.ready)this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),hit=view.posAtCoords(point);if(hit)view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));view.focus();});}
  focus(){if(this.ready)this.crepe.editor.action(ctx=>ctx.get(editorViewCtx).focus());}
  readonly(value:boolean){if(value){this.closeCandidates();this.stylePanel?.dispose();}if(this.ready)this.crepe.setReadonly(value);}
  /** 保存/退出时同步取得最新正文，不能等待输入通知的防抖计时器。 */
  read(){if(!this.disposed&&(this.ready||this.pendingRead)){if(this.ready)this.captureImageWidths();const current=this.ready?this.crepe.getMarkdown():this.pendingRead!();if(current!==this.baseline){this.original=this.mergeMarkdown(current);this.baseline=current;}}return joinTail(this.original,this.tail);}
  /** 外部属性修改仅同步投影；程序更新不触发用户输入回调。 */
  replace(body:string){const part=richBodyParts(body);this.tail=part.tail;if(part.body===this.original)return;
    // 保存可能整理首尾空行；语义未变时只更新原文基准，不制造一次看不见的撤销操作。
    const unchanged=JSON.stringify(tree(stripBlockIds(part.body)).children.map(key))===JSON.stringify(tree(stripBlockIds(this.original)).children.map(key));
    if(!this.ready||unchanged){this.original=part.body;return;}
    this.silent=true;try{this.crepe.editor.action(replaceAll(stripBlockIds(part.body)));const baseline=this.crepe.getMarkdown();this.original=part.body;this.baseline=baseline;}finally{this.silent=false;}}
  find(query:string){if(!this.ready||!query)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);let found=false;view.state.doc.descendants((node,pos)=>{if(found||!node.isText)return;const at=(node.text??'').toLocaleLowerCase().indexOf(query.toLocaleLowerCase());if(at>=0){view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos+at,pos+at+query.length)).scrollIntoView());view.focus();found=true;}});});}
  dispose(){this.disposed=true;this.disposeCaret?.();this.stylePanel?.dispose();this.root.removeEventListener('dragover',this.documentDragOver,true);this.root.removeEventListener('drop',this.documentDrop,true);this.root.removeEventListener('dragleave',this.documentDragLeave);window.removeEventListener('cewen:document-drag-end',this.clearDocumentDrop);this.clearDocumentDrop();this.root.removeEventListener('keydown',this.keydown,true);this.root.removeEventListener('keyup',this.keyup);this.root.removeEventListener('input',this.onInput);this.root.removeEventListener('compositionstart',this.onCompositionStart);this.root.removeEventListener('compositionend',this.onCompositionEnd);this.root.removeEventListener('focusout',this.onFocusOut);this.root.removeEventListener('mouseup',this.onSelectionMove);document.removeEventListener('selectionchange',this.onSelectionMove);this.root.removeEventListener('pointerdown',this.onImagePointerDown,true);this.root.removeEventListener('pointerover',this.onImageHandleHover);this.root.removeEventListener('load',this.onImageLoad,true);window.removeEventListener('pointerup',this.onImagePointerUp);this.closeCandidates();this.observer?.disconnect();if(this.ready)void this.crepe.destroy();}
}
