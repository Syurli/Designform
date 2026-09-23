import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, nodeViewCtx, prosePluginsCtx, remarkPluginsCtx } from '@milkdown/kit/core';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { imageSchema, toggleStrongCommand, wrapInHeadingCommand } from '@milkdown/kit/preset/commonmark';
import { TextSelection } from '@milkdown/kit/prose/state';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Root } from 'mdast';
import { parseSizedImage, sizedImageMarkup } from '../shared/image-markup';
import { stripBlockIds, transferBlockIds } from '../shared/document-blocks';
import { anchorHtmlView, designCodeBlockView, headingFoldingPlugin } from './rich-document-plugins';
import type { RichDesignOptions } from './rich-document-plugins';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import './rich-writing.css';

const hasBlockIds=(text:string)=>/<!--\s*cewen:block\s+[\w-]+\s*-->/.test(text);

const tree=(text:string)=>fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]});
/** Crepe 的 remark 链可能把独立 HTML 图片包装进段落；先提升到块级再交给 ProseMirror。 */
const sizedImageRemarkPlugin=()=> (root:Root)=>{
  root.children=root.children.map(node=>{
    const meaningful=node.type==='paragraph'?node.children.filter(child=>child.type!=='text'||child.value.trim()):[];
    const candidate=node.type==='paragraph'&&meaningful.length===1?meaningful[0]:node;
    const image=candidate.type==='html'?parseSizedImage(candidate.value):null;
    return image?{type:'image-block',url:image.src,alt:image.alt,title:image.title,data:{widthPx:image.width},position:node.position} as unknown as Root['children'][number]:node;
  });
};
/** 功能索引沿用原有段落间距，打开再保存不得平白增添空行。 */
const joinTail=(body:string,tail:string)=>tail?body+(/\n\s*\n$/.test(body)?'':'\n\n')+tail:body;
/** 只比较语义，位置与解析器附加缓存不影响原文片段是否可以直接保留。 */
const key=(node:Nodes):string=>JSON.stringify(node,(name,value)=>{
  if(name==='position'||name==='data'||name==='spread')return undefined;
  if(value&&typeof value==='object'&&value.type==='html'){const image=parseSizedImage(String(value.value??''));if(image)return {type:'html',image};}
  return typeof value==='string'?value.replace(/\r\n/g,'\n'):value;
});
export function richBodyParts(body:string){
  const nodes=tree(body).children.filter(node=>!(node.type==='html'&&/^<!-- cewen:block [A-Za-z0-9][A-Za-z0-9_-]{0,119} -->$/.test(node.value.trim()))),at=nodes.findIndex(node=>node.type==='heading'&&node.depth===3&&node.children.length===1&&node.children[0].type==='text'&&node.children[0].value==='关联索引');
  if(at<0)return {body,tail:''};
  const tail=nodes.slice(at);
  if(tail.some(node=>node.type!=='table'&&!(node.type==='heading'&&node.children[0]?.type==='text'&&node.children[0].value==='关联索引')))return {body,tail:''};
  const offset=nodes[at].position!.start.offset!;return {body:body.slice(0,offset),tail:body.slice(offset)};
}
/** 特殊 HTML 使用源码；知识锚点与编辑器自身输出的空行标记可以无损保留。 */
export function richUnsupported(text:string){
  let reason='';
  const inspect=(node:Nodes,parent='root')=>{
    if(node.type==='html'&&!(parent==='root'&&parseSizedImage(node.value))&&!/^\s*<!--\s*cewen:block\s+[\w-]+\s*-->\s*$/.test(node.value)&&!/^\s*(?:<br\s*\/?>|<a\s+id=["'][\w-]+["']\s*>|<\/a>|<a\s+id=["'][\w-]+["']\s*>\s*<\/a>)\s*$/.test(node.value))reason='这份文档含有自定义 HTML，已使用源码编辑以保留原文。';
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
  private candidates:RichLinkCandidate[]=[];
  private candidateBox?:HTMLElement;
  private candidateRange?:{from:number;to:number};
  private candidateIndex=0;
  private skipCandidateKeyup=false;
  private composing=false;
  private resizeHost?:HTMLElement;
  private uploadError(error:unknown){
    const box=this.root.closest('dialog')?.querySelector<HTMLElement>('#workbench-feedback');
    if(box){box.hidden=false;box.classList.add('error');box.textContent=`图片未能加入草稿：${error instanceof Error?error.message:'请重试或改用源码编辑。'}`;}
  }
  private mergeMarkdown(next:string){return hasBlockIds(this.original)?transferBlockIds(this.original,preserveBlocks(stripBlockIds(this.original),next)):preserveBlocks(this.original,next);}
  constructor(private root:HTMLElement,body:string,private onChange:(body:string)=>void,upload:(file:File)=>Promise<string>,resolveImage:(url:string)=>string,private onLink:()=>void,options:RichDesignOptions={}){
    const part=richBodyParts(body);this.original=part.body;this.tail=part.tail;
    // Crepe 浮层挂在传入 root 下；其主题 CSS 只匹配 .milkdown 的后代。
    root.classList.add('milkdown');
    this.crepe=new Crepe({root,defaultValue:stripBlockIds(part.body),features:{[Crepe.Feature.Latex]:false,[Crepe.Feature.CodeMirror]:false},featureConfigs:{
      [Crepe.Feature.Placeholder]:{text:'写下设计，输入 / 插入内容，输入 [[ 引用其他 DD',mode:'doc'},
      [Crepe.Feature.ImageBlock]:{onUpload:async file=>{try{return await upload(file);}catch(error){this.uploadError(error);throw error;}},proxyDomURL:resolveImage,inlineUploadButton:'选择图片',inlineUploadPlaceholderText:'或粘贴图片链接',blockUploadButton:'选择图片',blockConfirmButton:'插入',blockCaptionPlaceholderText:'图片说明',blockUploadPlaceholderText:'或粘贴图片链接'},
      [Crepe.Feature.LinkTooltip]:{inputPlaceholder:'粘贴网址；项目文档请按 Ctrl+K'},
      [Crepe.Feature.BlockEdit]:{textGroup:{label:'正文',text:{label:'段落'},h1:{label:'一级标题'},h2:{label:'二级标题'},h3:{label:'三级标题'},h4:{label:'四级标题'},h5:{label:'五级标题'},h6:{label:'六级标题'},quote:{label:'引用'},divider:{label:'分隔线'}},listGroup:{label:'列表',bulletList:{label:'项目列表'},orderedList:{label:'编号列表'},taskList:{label:'待办清单'}},advancedGroup:{label:'插入',image:{label:'图片'},table:{label:'表格'},codeBlock:{label:'代码块'},math:null},slashMenu:{root},blockHandle:{root}},
    }});
    // 图片块保留真实 alt；缩放写入公开 HTML 像素宽度，不再把倍率污染到 ![alt]。
    this.crepe.editor.config(ctx=>{
      ctx.update(remarkPluginsCtx,previous=>[...previous,{plugin:sizedImageRemarkPlugin,options:{}}]);
      // 折叠使用装饰层；对白和色板 NodeView 只改变呈现，保存仍修改原代码块。
      ctx.update(prosePluginsCtx,previous=>[...previous,headingFoldingPlugin()]);
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
  async create(){await this.crepe.create();if(this.disposed){await this.crepe.destroy();return;}this.baseline=this.crepe.getMarkdown();const semantic=(text:string)=>JSON.stringify(tree(stripBlockIds(text)).children.map(key));if(semantic(this.original)!==semantic(this.baseline)){this.ready=true;throw new Error('此文档的块结构无法无损往返，请保留源码编辑。');}this.ready=true;this.root.querySelector('.ProseMirror')?.setAttribute('aria-label','策划正文');this.root.querySelector('.ProseMirror')?.setAttribute('role','textbox');this.root.querySelector('.ProseMirror')?.setAttribute('aria-multiline','true');this.root.querySelectorAll<HTMLElement>('.image-resize-handle').forEach(handle=>handle.title='拖动调整图片大小');this.root.querySelectorAll<HTMLImageElement>('.milkdown-image-block img').forEach(image=>{if(image.complete&&image.naturalWidth)this.onImageLoad({target:image} as unknown as Event);});}
  private keydown=(event:KeyboardEvent)=>{
    if(event.isComposing||this.composing||event.keyCode===229)return;
    if(this.candidateRange&&this.candidateBox&&!this.candidateBox.hidden){
      const buttons=[...this.candidateBox.querySelectorAll<HTMLButtonElement>('button[data-candidate]')];
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.candidateIndex=(this.candidateIndex+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;this.markCandidate();return;}
      if(event.key==='Enter'&&buttons.length){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.chooseCandidate(Number(buttons[this.candidateIndex].dataset.candidate));return;}
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.skipCandidateKeyup=true;this.closeCandidates();return;}
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopPropagation();this.closeCandidates();this.rememberSelection();this.onLink();}
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
  selectedText(){if(!this.ready)return '';return this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection;return view.state.doc.textBetween(range.from,range.to);});}
  /** 插入实际 Markdown 链接，选择器中的标题与身份不会混入正文。 */
  link(url:string,label:string){if(!this.ready)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx),range=this.selection??view.state.selection,mark=view.state.schema.marks.link.create({href:url});const tr=view.state.tr.replaceWith(range.from,range.to,view.state.schema.text(label,[mark]));view.dispatch(tr);view.focus();});this.selection=undefined;}
  insert(markdown:string){if(this.ready){this.crepe.editor.action(insert(markdown));this.focus();}}
  format(kind:string){if(!this.ready)return;if(kind==='bold')this.crepe.editor.action(callCommand(toggleStrongCommand.key));else if(kind==='heading')this.crepe.editor.action(callCommand(wrapInHeadingCommand.key,2));else this.insert(({list:'\n- 列表项\n',quote:'\n> 引用内容\n',table:'\n| 项目 | 说明 |\n| --- | --- |\n| 名称 | 内容 |\n'} as Record<string,string>)[kind]??'');}
  undo(){if(this.ready)this.crepe.editor.action(callCommand(undoCommand.key));}
  redo(){if(this.ready)this.crepe.editor.action(callCommand(redoCommand.key));}
  focus(){if(this.ready)this.crepe.editor.action(ctx=>ctx.get(editorViewCtx).focus());}
  readonly(value:boolean){if(value)this.closeCandidates();if(this.ready)this.crepe.setReadonly(value);}
  /** 保存/退出时同步取得最新正文，不能等待输入通知的防抖计时器。 */
  read(){if(this.ready){this.captureImageWidths();const current=this.crepe.getMarkdown();if(current!==this.baseline){this.original=this.mergeMarkdown(current);this.baseline=current;}}return joinTail(this.original,this.tail);}
  /** 外部属性修改仅同步投影；程序更新不触发用户输入回调。 */
  replace(body:string){const part=richBodyParts(body);this.tail=part.tail;if(part.body===this.original)return;
    // 保存可能整理首尾空行；语义未变时只更新原文基准，不制造一次看不见的撤销操作。
    const unchanged=JSON.stringify(tree(stripBlockIds(part.body)).children.map(key))===JSON.stringify(tree(stripBlockIds(this.original)).children.map(key));
    if(!this.ready||unchanged){this.original=part.body;return;}
    this.silent=true;try{this.crepe.editor.action(replaceAll(stripBlockIds(part.body)));const baseline=this.crepe.getMarkdown();this.original=part.body;this.baseline=baseline;}finally{this.silent=false;}}
  find(query:string){if(!this.ready||!query)return;this.crepe.editor.action(ctx=>{const view=ctx.get(editorViewCtx);let found=false;view.state.doc.descendants((node,pos)=>{if(found||!node.isText)return;const at=(node.text??'').toLocaleLowerCase().indexOf(query.toLocaleLowerCase());if(at>=0){view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos+at,pos+at+query.length)).scrollIntoView());view.focus();found=true;}});});}
  dispose(){this.disposed=true;this.root.removeEventListener('keydown',this.keydown,true);this.root.removeEventListener('keyup',this.keyup);this.root.removeEventListener('input',this.onInput);this.root.removeEventListener('compositionstart',this.onCompositionStart);this.root.removeEventListener('compositionend',this.onCompositionEnd);this.root.removeEventListener('focusout',this.onFocusOut);this.root.removeEventListener('mouseup',this.onSelectionMove);document.removeEventListener('selectionchange',this.onSelectionMove);this.root.removeEventListener('pointerdown',this.onImagePointerDown,true);this.root.removeEventListener('pointerover',this.onImageHandleHover);this.root.removeEventListener('load',this.onImageLoad,true);window.removeEventListener('pointerup',this.onImagePointerUp);this.closeCandidates();this.observer?.disconnect();if(this.ready)void this.crepe.destroy();}
}
