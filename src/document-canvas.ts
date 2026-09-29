import { setMetadata } from '../shared/editing';
import type { LayoutCompanion } from '../shared/document-companion.ts';
import { ensureBlockIds, parseDocumentBlocks, stripBlockIds, transferBlockIds, serializeDocumentBlocks, blockSubtree, reparentDocumentBlock, reorderDocumentBlock, type DocumentBlock } from '../shared/document-blocks.ts';
import { RichWriting, type TextFormatting } from './rich-writing';
import { DOCUMENT_DRAG_TYPE, readDocumentDrag, type DocumentDrag } from './document-drag';
import { appChoice } from './app-dialog';
import './document-canvas.css';
import { showAppMenu } from './app-menu';
import { inputPreferences, shortcutAction } from './input-settings';
import { parseObject,objectBlock } from '../shared/creative/content';
import { cloneCreativeObject } from '../shared/creative/clone';
import { moduleRegistry } from '../shared/creative/registry';

/** 坐标属于未缩放的画布纸面，不随屏幕平移、缩放或滚动变化。 */
export interface CanvasPoint { x:number; y:number }

export interface DocumentCanvasOptions {
  markdown: string;
  layout: LayoutCompanion;
  /** 渲染器必须返回已过滤的安全 HTML；画布不执行原始 Markdown 内的 HTML。 */
  render(markdown: string): string;
  onChange(markdown: string, layout: LayoutCompanion): void;
  onEditBlock?: (id: string, source: string, done: (nextSource: string) => void) => void;
  onRender?: (host: HTMLElement) => void;
  /** 空白右键携带落点；文件选择及插入种类由桌面入口提供。 */
  onInsert?: (point?:CanvasPoint) => void;
  /** 目录拖放必须由桌面重新核对身份，然后调用 appendAt 创建独立引用块。 */
  onDocumentDrop?: (item:DocumentDrag,point:CanvasPoint) => void;
  /** 只请求重新导入图片，选择的文件仍由桌面保存在当前草稿。 */
  onReimportImage?: (id:string,source:string) => void;
  /** 富文本 Ctrl+K 沿用工作台引用选择器，避免被编辑器空回调吞掉。 */
  onLink?:()=>void;
  /** 阅读页使用现有公开布局；不补身份标记，也不写入草稿。 */
  readOnly?: boolean;
  /** 桌面把画布工具并入标签行，每个标签仍拥有独立命令实例。 */
  toolbarHost?:HTMLElement;
  /** 桌面正文在块内编辑；其他使用者可继续提供自己的编辑回调。 */
  inlineEditing?: boolean;
  /** 阅读段落的原位编辑结束后，桌面重新挂载同一份文档投影。 */
  onFinishEditing?: () => void;
}

/** Markdown 决定阅读顺序，布局只控制同一纸面上的显示坐标。 */
export class DocumentCanvas {
  private markdown: string;
  private layout: LayoutCompanion;
  private blocks: DocumentBlock[] = [];
  private selected = new Set<string>();
  private collapsed = new Set<string>();
  private root = document.createElement('div');
  private stage = document.createElement('div');
  private viewport = document.createElement('div');
  private pan = { x: 0, y: 0, scale: 1 };
  private suppressContext = false;
  private cancelGesture?:()=>void;
  private ratio = true;
  private snap = true;
  private disposed = false;
  private toolbarNode?:HTMLElement;
  private toolbarVisible=false;
  /** 只允许本实例亲自生成的自动坐标让位，读入的公开坐标一律按人工布局保留。 */
  private automaticPositions=new Set<string>();
  private insertionAnchors=new Map<string,string>();
  private reflowIndex?:number;
  private measuredWidth=800;
  /** 解码结果仅在实例内缓存，避免重绘时用未知比例重复挤压自动块；不增加公开布局字段。 */
  private imageSizes=new Map<string,{width:number;height:number}>();
  private hasExplicitChange=false;
  private editing?: { id:string; rich?:RichWriting; host:HTMLElement; update:(text:string)=>void; read:()=>string; changed:boolean; ready?:Promise<void> };
  /** 切换模式、保存与离开标签时同步编辑器；组合输入期间不重建正文 DOM。 */
  finishEditing(){const edit=this.editing;if(!edit)return;edit.update(edit.read());this.editing=undefined;edit.rich?.dispose();this.render();this.options.onFinishEditing?.();}
  /** 两种视图共用编辑状态，输入期间禁止重建阅读段落，避免光标及组合输入丢失。 */
  get isEditing(){return !!this.editing;}
  /** 整份文档的个人锁定与历史只读都从此入口阻止内容及排版写入。 */
  setReadOnly(value:boolean){if(value===!!this.options.readOnly)return;this.finishEditing();this.cancelGesture?.();this.options.readOnly=value;if(!value)this.markdown=ensureBlockIds(this.markdown);this.root.classList.toggle('is-read-only',value);this.root.tabIndex=value?-1:0;this.render();}
  /** 文档视图保留线性排版，编辑器使用自由视图的同一正文和撤销链。 */
  editInHost(id:string,host:HTMLElement,point?:{left:number;top:number}){const block=this.blocks.find(item=>item.id===id);if(block)this.edit(block,point,host);}
  /** 线性视图使用相同的块类型和锁检查，避免拦截专用模块的阅读按钮。 */
  canEditBlock(id:string){const block=this.blocks.find(item=>item.id===id);return !!block&&!this.options.readOnly&&!this.layout.locked?.includes(id)&&this.canEditInline(block);}
  startEditing(id?:string){const block=this.blocks.find(b=>id?b.id===id:['heading','paragraph','list','table','blockquote'].includes(b.type));if(block)this.edit(block);}
  setToolbarVisible(visible:boolean){this.toolbarVisible=visible;if(this.toolbarNode)this.toolbarNode.hidden=!visible;}
  /** 工具页点击失焦后仍使用原正文选区，整个工具操作不结束原位编辑。 */
  rememberTextSelection(){this.editing?.rich?.rememberTextSelection();}
  formatText(kind:'bold'|'italic'|'style'){return !this.options.readOnly&&(this.editing?.rich?.formatText(kind)??false);}
  paragraphType(){return this.editing?.rich?.paragraphType()??'paragraph';}
  formatParagraph(kind:string){return !this.options.readOnly&&(this.editing?.rich?.formatParagraph(kind)??false);}
  /** 浏览导航恢复个人镜头，排版与公开文档保持原样。 */
  readingPosition(){return {...this.pan};}
  restoreReadingPosition(pan:{x:number;y:number;scale:number}){this.pan={...pan};this.transform();}
  /** 块剪贴板与原生文字剪贴板分流；复制建立新块身份，删除可撤销。 */
  async clipboard(command:'copy'|'cut'|'paste'|'selectAll'|'delete'){
    if(command==='selectAll'){this.selected=new Set(this.blocks.filter(block=>block.id).map(block=>block.id));this.stage.querySelectorAll<HTMLElement>('[data-block-id]').forEach(card=>card.classList.toggle('is-selected',this.selected.has(card.dataset.blockId!)));return;}
    if(command==='delete'){await this.removeSelected();return;}
    if(command==='copy'||command==='cut'){const source=stripBlockIds(serializeDocumentBlocks('',this.blocks.filter(block=>this.selected.has(block.id))));if(!source)return;await navigator.clipboard.writeText(source);if(command==='cut')await this.removeSelected();return;}
    if(this.options.readOnly)return;const text=await navigator.clipboard.readText();
    // 粘贴创作模块建立独立身份；媒体继续引用原素材，避免重复声明同一资源。
    const copied=text.replace(/^```cewen-object\s*\n([\s\S]*?)^```/gm,(source,body:string)=>{try{const object=parseObject(body);if(object.type==='media'){const reference=moduleRegistry.get('reference')!.create('object-'+crypto.randomUUID(),object.title);reference.data.objectId=object.id;return objectBlock(reference);}return objectBlock(cloneCreativeObject(object,'object-'+crypto.randomUUID(),()=> 'row-'+crypto.randomUUID()));}catch{return source;}});
    if(copied.trim())this.insertAfter(copied,[...this.selected].at(-1));
  }
  highlightText(color:string){return !this.options.readOnly&&(this.editing?.rich?.highlightText(color)??false);}
  copyTextFormatting():TextFormatting|undefined{return this.editing?.rich?.copyTextFormatting();}
  applyTextFormatting(format:TextFormatting){return !this.options.readOnly&&(this.editing?.rich?.applyTextFormatting(format)??false);}
  /** 复用该段落原有创建任务，等待期间切块或锁定则取消引用插入，绝不再次 create。 */
  async insertInlineReference(blockId:string,readingHost:HTMLElement,ref:{href:string;title:string;color:string},point:{left:number;top:number}):Promise<boolean>{
    if(!this.canEditBlock(blockId))return false;this.editInHost(blockId,readingHost,point);const edit=this.editing;if(!edit||edit.id!==blockId)return false;await edit.ready;if(this.editing!==edit||this.options.readOnly||this.disposed||!edit.rich)return false;return edit.rich.linkColored(ref,point);
  }
  private past: { markdown: string; layout: LayoutCompanion }[] = [];
  private future: { markdown: string; layout: LayoutCompanion }[] = [];
  private readonly keydown = (event: KeyboardEvent) => {
    // 编辑器已经处理的按键及中文组合输入不能再被画布的快捷键截获。
    if(event.defaultPrevented||event.isComposing)return;
    if(event.key==='Escape'){this.cancelGesture?.();this.finishEditing();return;}
    const target = event.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||target.closest('[contenteditable=true]'))return;
    const action=shortcutAction(event);
    if(action==='undo'||action==='redo'){event.preventDefault();action==='redo'?this.redo():this.undo();}
    else if(action&&['copy','cut','paste','selectAll','delete'].includes(action)){event.preventDefault();void this.clipboard(action as 'copy'|'cut'|'paste'|'selectAll'|'delete').catch(error=>window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error})));}
  };

  constructor(private host: HTMLElement, private options: DocumentCanvasOptions) {
    this.markdown = options.readOnly ? options.markdown : ensureBlockIds(options.markdown);
    this.layout = structuredClone(options.layout);
    this.root.className = `document-canvas${options.readOnly ? ' is-read-only' : ''}`;
    this.root.tabIndex = options.readOnly ? -1 : 0;
    this.root.addEventListener('keydown', this.keydown);
    this.stage.className = 'document-canvas-stage';
    this.viewport.className = 'document-canvas-viewport';
    this.viewport.addEventListener('pointerdown', event => this.backgroundGesture(event));
    this.viewport.addEventListener('contextmenu', event => {
      event.preventDefault(); if(this.options.readOnly)return;
      if(this.suppressContext){this.suppressContext=false;return;}
      const id=(event.target as HTMLElement).closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      if(id&&!this.selected.has(id))this.select(event,id);
      const point=this.at(event.clientX,event.clientY),image=id?this.blocks.find(block=>block.id===id&&this.imageOnlySource(block.source)):undefined;
      showAppMenu([
        ...(!id?[{label:'插入…',disabled:!this.options.onInsert,run:()=>this.options.onInsert?.(point)}]:[]),
        ...(image?[{label:'重新导入图片…',disabled:!this.options.onReimportImage||this.layout.locked?.includes(image.id),run:()=>this.options.onReimportImage?.(image.id,image.source)}]:[]),
        {label:'编辑内容',disabled:!this.selected.size||!!image,run:()=>{const block=this.blocks.find(b=>this.selected.has(b.id));if(block)this.edit(block);}},
        {label:'移到文档直属内容',disabled:this.selected.size!==1,run:()=>this.changeParent([...this.selected][0])},
        {label:'移到上一级章节',disabled:this.selected.size!==1,run:()=>{const b=this.blocks.find(b=>this.selected.has(b.id));if(b)this.changeParent(b.id,this.blocks.find(p=>p.id===b.section)?.section);}},
        {label:'删除选中块（保留章节正文）',danger:true,disabled:!this.selected.size,run:()=>this.removeSelected()},
        {label:'删除整个章节及内容…',danger:true,disabled:!this.selected.size,run:()=>this.removeSelected(true)},
        {label:'适应画布',run:()=>this.fit()},
      ],this.viewport,{x:event.clientX,y:event.clientY});
    });
    // 自由视图的目录拖放先于内部富文本处理，引用始终成为落点上的独立块。
    this.viewport.addEventListener('dragover',event=>{if(!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=this.options.readOnly?'none':'copy';},{capture:true});
    this.viewport.addEventListener('drop',event=>{if(!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();if(this.options.readOnly)return;const item=readDocumentDrag(event.dataTransfer);if(item)this.options.onDocumentDrop?.(item,this.at(event.clientX,event.clientY));},{capture:true});
    this.viewport.addEventListener('wheel',event=>{
      if((event.target as HTMLElement).closest('.creative-map,textarea,input,.ProseMirror,.document-canvas-content'))return;
      event.preventDefault();const r=this.viewport.getBoundingClientRect(),next=Math.min(2,Math.max(.15,this.pan.scale*Math.exp(-event.deltaY*.001)));
      const x=event.clientX-r.left,y=event.clientY-r.top;
      this.pan={x:x-(x-this.pan.x)*next/this.pan.scale,y:y-(y-this.pan.y)*next/this.pan.scale,scale:next};this.transform();
    },{passive:false});
    this.host.replaceChildren(this.root);
    this.render();
  }

  /** 属性栏与内联编辑都进入当前文档的撤销链。 */
  replace(markdown:string,layout=this.layout) {
    if(this.options.readOnly)return;
    const externalLayout=layout!==this.layout;
    this.finishEditing();
    if(markdown===this.markdown&&JSON.stringify(layout)===JSON.stringify(this.layout))return;
    this.checkpoint();this.markdown=ensureBlockIds(markdown);this.layout=structuredClone(layout);if(externalLayout)this.automaticPositions.clear();this.emit();this.render();
  }
  /** 归属是项目结构草稿；同步撤销链中的元数据，不把移动误记为正文编辑。 */
  relocate(system:string,parent?:string){
    if(this.options.readOnly)return;
    const values={system:system||undefined,parent};
    this.markdown=setMetadata(this.markdown,values);
    for(const state of [...this.past,...this.future])state.markdown=setMetadata(state.markdown,values);
    this.render();
  }
  refresh(){if(!this.editing)this.render();}
  /** 大纲与查找定位只移动视口，不改变布局和阅读顺序。 */
  locate(id:string){
    let block=this.stage.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)??this.stage.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)?.closest<HTMLElement>('[data-block-id]');
    if(!block)return false;
    // 定位折叠章节时展开其父链；仅修改阅读状态，不写入布局或正式正文。
    const blockId=block.dataset.blockId!,byId=new Map(this.blocks.map(item=>[item.id,item]));
    let parent=byId.get(blockId)?.section,changed=false;const seen=new Set<string>();
    while(parent&&!seen.has(parent)){seen.add(parent);changed=this.collapsed.delete(parent)||changed;parent=byId.get(parent)?.section;}
    if(changed){this.render(false);block=this.stage.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)!;}
    const scale=this.pan.scale;this.pan={x:24-block.offsetLeft*scale,y:24-block.offsetTop*scale,scale};this.transform();
    block.classList.remove('is-section-target');void block.offsetWidth;block.classList.add('is-section-target');
    block.tabIndex=-1;block.focus({preventScroll:true});return true;
  }
  find(query:string){const block=[...this.stage.querySelectorAll<HTMLElement>('[data-block-id]')].find(b=>b.textContent?.toLowerCase().includes(query.toLowerCase()));if(block)this.locate(block.dataset.blockId!);return !!block;}
  append(markdown:string) {this.replace(this.markdown.trimEnd()+'\n\n'+markdown.trim()+'\n');}
  /** 屏幕指针换算为纸面坐标，右键、目录拖放与插入共用同一套换算。 */
  at(clientX:number,clientY:number):CanvasPoint{const rect=this.viewport.getBoundingClientRect();return {x:(clientX-rect.left-this.pan.x)/this.pan.scale,y:(clientY-rect.top-this.pan.y)/this.pan.scale};}
  /** 纸面坐标还原为客户端落点，插入子菜单在用户右键的位置打开。 */
  clientAt(point:CanvasPoint):{x:number;y:number}{const rect=this.viewport.getBoundingClientRect();return {x:rect.left+this.pan.x+point.x*this.pan.scale,y:rect.top+this.pan.y+point.y*this.pan.scale};}
  /** 坐标插入保留原布局，并将新根块显式设为文档直属，不借末尾标题推断归属。 */
  appendAt(markdown:string,point:CanvasPoint):string[]{
    if(this.options.readOnly||!Number.isFinite(point.x)||!Number.isFinite(point.y))return [];
    this.finishEditing();const incoming=parseDocumentBlocks(ensureBlockIds(stripBlockIds(markdown))).map(block=>({...block}));if(!incoming.length)return [];
    this.checkpoint();const ids=incoming.filter(block=>block.id).map(block=>block.id);
    const first=incoming.find(block=>block.id&&!block.section);if(first)this.layout.blocks[first.id]={x:point.x,y:point.y};
    this.markdown=serializeDocumentBlocks(this.markdown,[...this.blocks,...incoming]);this.selected=new Set(ids);this.emit();this.render();return ids;
  }
  /** 图片重导入等替换只替换一个最小块，原身份、坐标、分组、层级与撤销记录继续保留。 */
  replaceBlock(id:string,markdown:string):boolean{
    if(this.options.readOnly||this.layout.locked?.includes(id))return false;this.finishEditing();
    const index=this.blocks.findIndex(block=>block.id===id),parts=parseDocumentBlocks(stripBlockIds(markdown));if(index<0||parts.length!==1)return false;
    const before=this.blocks[index],part={...parts[0],id,section:before.section};if(part.source===before.source)return false;
    this.checkpoint();const next=[...this.blocks];next[index]=part;this.markdown=serializeDocumentBlocks(this.markdown,next);
    // 新图片以新比例适应原宽度；旧图片的固定高度不能把新图拉成空白大框。
    if(this.imageOnlySource(part.source)&&this.layout.blocks[id])delete this.layout.blocks[id].height;
    this.emit();this.render();return true;
  }
  /** 阅读页按源块身份插入，现有顺序及身份不重新分配，画布新位置采用既有避让逻辑。 */
  insertAfter(markdown:string,afterId?:string):string[]{
    if(this.options.readOnly)return [];this.finishEditing();const incoming=parseDocumentBlocks(ensureBlockIds(stripBlockIds(markdown))).map(block=>({...block}));if(!incoming.length)return [];
    const at=afterId?this.blocks.findIndex(block=>block.id===afterId):-1;if(afterId&&at<0)return [];const index=at<0?this.blocks.length:at+1,ids=incoming.filter(block=>block.id).map(block=>block.id);
    this.checkpoint();this.markdown=serializeDocumentBlocks(this.markdown,[...this.blocks.slice(0,index),...incoming,...this.blocks.slice(index)]);this.reflowIndex=index;if(afterId)for(const id of ids)this.insertionAnchors.set(id,afterId);this.selected=new Set(ids);this.emit();this.render();return ids;
  }
  /** 独立图片没有伴随正文；混合图文段落仍保持普通文字编辑。 */
  private imageOnlySource(source:string){const host=document.createElement('div');host.innerHTML=this.options.render(stripBlockIds(source));return this.imageOnly(host);}
  private imageOnly(host:HTMLElement){return host.querySelectorAll('img').length===1&&!host.textContent?.trim()&&!host.querySelector('audio,video,pre,table');}
  private transform(){this.stage.style.transform=`translate(${this.pan.x}px,${this.pan.y}px) scale(${this.pan.scale})`;this.viewport.style.setProperty('--canvas-grid-size',`${24*this.pan.scale}px`);this.viewport.style.setProperty('--canvas-grid-x',`${this.pan.x}px`);this.viewport.style.setProperty('--canvas-grid-y',`${this.pan.y}px`);}
  fit(){const bounds=[...this.stage.querySelectorAll<HTMLElement>('[data-block-id]:not([hidden])')];const maxX=Math.max(600,...bounds.map(b=>b.offsetLeft+b.offsetWidth)),maxY=Math.max(300,...bounds.map(b=>b.offsetTop+b.offsetHeight));this.pan={x:20,y:20,scale:Math.min(1,(this.viewport.clientWidth-40)/maxX,(this.viewport.clientHeight-40)/maxY)};this.transform();}
  private async removeSelected(entire=false){
    if(this.options.readOnly||!this.selected.size)return;this.finishEditing();const selected=new Set(this.selected);
    if(entire){for(const id of this.selected)for(const child of blockSubtree(this.blocks,id))selected.add(child);if(await appChoice('删除章节及内容',`将删除 ${selected.size} 个块，可在保存前撤销。`,[{id:'cancel',label:'取消'},{id:'delete',label:'删除整个章节及内容'}])!=='delete'||this.options.readOnly)return;}
    const next=this.blocks.filter(b=>!selected.has(b.id)).map(b=>({...b}));
    for(const b of next){
      if(b.type==='heading'){let parent=b.section,removed=0;while(parent){const ancestor=this.blocks.find(p=>p.id===parent);if(selected.has(parent))removed++;parent=ancestor?.section;}if(removed){b.depth=Math.max(1,(b.depth??1)-removed);b.source=b.source.replace(/^#{1,6}(?=\s)/,'#'.repeat(b.depth));}}
      while(b.section&&selected.has(b.section))b.section=this.blocks.find(p=>p.id===b.section)?.section;
    }
    this.applyStructure(serializeDocumentBlocks(this.markdown,next));this.selected.clear();
  }
  /** 空白左拖平移、右拖框选；内容内部的手势由对应编辑器负责。 */
  private backgroundGesture(event:PointerEvent){
    if(event.button!==0&&event.button!==2)return;
    if((event.target as HTMLElement).closest('.document-canvas-block'))return;
    if(event.button===0)this.finishEditing();
    event.preventDefault();this.root.focus({preventScroll:true});const start={x:event.clientX,y:event.clientY},pan={...this.pan};let moved=false;
    const box=document.createElement('div');box.className='canvas-marquee';this.viewport.setPointerCapture(event.pointerId);
    const move=(e:PointerEvent)=>{if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<inputPreferences().dragThreshold&&!moved)return;moved=true;if(event.button===0){this.pan.x=pan.x+e.clientX-start.x;this.pan.y=pan.y+e.clientY-start.y;this.transform();}else{this.viewport.append(box);const r=this.viewport.getBoundingClientRect();Object.assign(box.style,{left:Math.min(start.x,e.clientX)-r.left+'px',top:Math.min(start.y,e.clientY)-r.top+'px',width:Math.abs(e.clientX-start.x)+'px',height:Math.abs(e.clientY-start.y)+'px'});}};
    const cleanup=()=>{this.cancelGesture=undefined;window.removeEventListener('blur',cancel);this.viewport.removeEventListener('pointermove',move);this.viewport.removeEventListener('pointerup',up);this.viewport.removeEventListener('pointercancel',cancel);box.remove();};
    const cancel=()=>{this.pan=pan;this.transform();cleanup();};
    const up=(e:PointerEvent)=>{if(event.button===2&&moved){this.suppressContext=true;setTimeout(()=>this.suppressContext=false,350);if(!event.ctrlKey&&!event.shiftKey)this.selected.clear();const x1=Math.min(start.x,e.clientX),x2=Math.max(start.x,e.clientX),y1=Math.min(start.y,e.clientY),y2=Math.max(start.y,e.clientY);this.stage.querySelectorAll<HTMLElement>('[data-block-id]:not([hidden])').forEach(card=>{const r=card.getBoundingClientRect();if(r.right>=x1&&r.left<=x2&&r.bottom>=y1&&r.top<=y2)this.selected.add(card.dataset.blockId!);card.classList.toggle('is-selected',this.selected.has(card.dataset.blockId!));});}cleanup();};
    this.cancelGesture=cancel;window.addEventListener('blur',cancel);this.viewport.addEventListener('pointermove',move);this.viewport.addEventListener('pointerup',up);this.viewport.addEventListener('pointercancel',cancel);
  }

  /** 返回可供同批次提交的正文与公开排版；读取不会改变用户稿。 */
  read() { return { markdown: this.markdown, layout: structuredClone(this.layout) }; }
  dispose() { this.editing?.rich?.dispose();this.editing=undefined;this.cancelGesture?.();this.disposed = true; this.root.removeEventListener('keydown', this.keydown); this.toolbarNode?.remove();this.host.replaceChildren(); this.selected.clear(); }

  /** 每次显式操作只保存一个前态；首次自动排版不占用户撤销步。 */
  private checkpoint() { this.past.push(this.read()); if (this.past.length > 80) this.past.shift(); this.future = []; }
  undo() { if(this.options.readOnly)return;if(this.editing?.rich){this.editing.rich.undo();return;}this.finishEditing();const prior = this.past.pop(); if (!prior) return; this.future.push(this.read()); this.markdown = prior.markdown; this.layout = prior.layout; this.emit(); this.render(); }
  redo() { if(this.options.readOnly)return;if(this.editing?.rich){this.editing.rich.redo();return;}this.finishEditing();const next = this.future.pop(); if (!next) return; this.past.push(this.read()); this.markdown = next.markdown; this.layout = next.layout; this.emit(); this.render(); }

  /** 结构变更保持绝对画布位置，局部坐标重新相对公开父级计算。 */
  private applyStructure(next:string){
    if(this.options.readOnly||next===this.markdown)return;
    const before=new Map(this.blocks.map(b=>[b.id,b])),positions=new Map(this.blocks.map(b=>[b.id,this.rawPosition(b,before)]));
    this.checkpoint();this.markdown=next;
    for(const b of parseDocumentBlocks(next)){const prior=this.layout.blocks[b.id],pos=positions.get(b.id),parent=b.section?positions.get(b.section):undefined;if(prior&&pos){this.layout.blocks[b.id]={...prior,x:pos.x-(parent?.x??0),y:pos.y-(parent?.y??0)};if(b.section)this.layout.blocks[b.id].section=b.section;else delete this.layout.blocks[b.id].section;}}
    const ids=new Set(parseDocumentBlocks(next).map(b=>b.id));for(const id of Object.keys(this.layout.blocks))if(!ids.has(id))delete this.layout.blocks[id];
    // 删除块时同步清理排版引用，撤销仍从完整前态恢复分组与锁定。
    if(this.layout.locked)this.layout.locked=this.layout.locked.filter(id=>ids.has(id));
    for(const [id,members] of Object.entries(this.layout.groups??{})){const kept=members.filter(member=>ids.has(member));if(kept.length>1)this.layout.groups![id]=kept;else delete this.layout.groups![id];}
    this.emit();this.render();
  }
  changeParent(id:string,parent?:string){this.finishEditing();try{this.applyStructure(reparentDocumentBlock(this.markdown,id,parent));}catch(error){window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error}));}}
  reorder(id:string,target:string,after=false){this.finishEditing();this.applyStructure(reorderDocumentBlock(this.markdown,id,target,after));}

  private emit() { if (!this.options.readOnly){this.hasExplicitChange=true;this.options.onChange(this.markdown, structuredClone(this.layout));} }
  private rawPosition(block: DocumentBlock, byId: Map<string, DocumentBlock>): { x: number; y: number } {
    const stored = this.layout.blocks[block.id];
    const parent = block.section ? byId.get(block.section) : undefined;
    const origin = parent ? this.rawPosition(parent, byId) : { x: 0, y: 0 };
    return { x: origin.x + (stored?.x ?? 0), y: origin.y + (stored?.y ?? 0) };
  }

  /** 交互坐标还原到所属章节局部坐标，折叠造成的视觉位移不写入布局。 */
  private localPosition(block: DocumentBlock, card: HTMLElement): { x: number; y: number } {
    const parent = block.section ? this.stage.querySelector<HTMLElement>(`[data-block-id="${block.section}"]`) : null;
    const parentX = parent ? parseFloat(parent.style.left) : 0;
    const parentY = parent ? parseFloat(parent.style.top) : 0;
    return { x: parseFloat(card.style.left) - parentX, y: parseFloat(card.style.top) - parentY };
  }

  private hidden(block: DocumentBlock, byId: Map<string, DocumentBlock>): boolean {
    let parent = block.section;
    while (parent) { if (this.collapsed.has(parent)) return true; parent = byId.get(parent)?.section; }
    return false;
  }

  private render(publishLayout=true) {
    // 折叠、排版菜单和外部刷新同样经过此处；编辑器创建及连续输入期间不能拆掉冻结尺寸的卡片。
    if (this.disposed || this.editing) return;
    this.blocks = parseDocumentBlocks(this.markdown);
    const byId = new Map(this.blocks.map(block => [block.id, block]));
    this.root.replaceChildren();
    this.toolbarNode?.remove();this.toolbarNode=undefined;
    if (!this.options.readOnly){this.toolbarNode=this.toolbar();if(this.options.toolbarHost){this.toolbarNode.hidden=!this.toolbarVisible;this.options.toolbarHost.append(this.toolbarNode);}else this.root.append(this.toolbarNode);}
    this.stage.replaceChildren(); this.viewport.replaceChildren(this.stage);this.root.append(this.viewport);this.transform();
    const cards: { block: DocumentBlock; index: number; card: HTMLElement; width:number; height: number; hidden: boolean }[] = [];
    // 文档视图隐藏自由画布时仍使用所属标签的真实宽度，不能把隐藏节点的 0px 当作排版宽度。
    this.measuredWidth=this.host.clientWidth||this.host.parentElement?.clientWidth||this.measuredWidth;
    const availableWidth = Math.max(120, this.measuredWidth - 72);
    const pendingAnchors: string[] = [];
    for (const [index, block] of this.blocks.entries()) {
      // Markdown 引用定义只是链接元信息，保留原文但不生成一张空白纸面卡片。
      if (block.type === 'definition') continue;
      // 单独的行内 <a> 也可能解析成 paragraph；都附着到下一张内容卡，避免空卡截走章节定位。
      const anchor = ['html','paragraph'].includes(block.type) ? /^<a\s+id=["']([A-Za-z0-9_-]+)["']\s*>\s*<\/a>\s*$/i.exec(block.source.trim()) : null;
      if (anchor) { pendingAnchors.push(anchor[1]); continue; }
      if (!block.id) continue;
      const stored = this.layout.blocks[block.id];
      const card = document.createElement('article');
      card.className = `document-canvas-block${block.type === 'heading' ? ' is-heading' : ''}${this.selected.has(block.id) ? ' is-selected' : ''}`;
      card.dataset.blockId = block.id;
      for (const id of pendingAnchors.splice(0)) { const target = document.createElement('span'); target.id = id; target.className = 'document-canvas-anchor'; card.append(target); }
      card.style.left = '0px'; card.style.top = '0px';
      // 新文本使用内容自然宽度；已由用户保存的尺寸继续尊重，手动缩放仍写入公开排版。
      const naturalText=['heading','paragraph','list','blockquote','code'].includes(block.type)&&!/^```(?:cewen|design)/.test(block.source);
      // 旧自动布局仅登记过宽度；手工缩放会同时登记宽高，只有后者继续使用固定文本尺寸。
      const fixedWidth=naturalText ? stored?.height?stored.width:undefined : stored?.width;
      card.style.width = fixedWidth ? `${fixedWidth}px` : naturalText ? 'max-content' : `${Math.min(620,availableWidth)}px`;
      if(naturalText&&!fixedWidth)card.style.maxWidth=`${Math.max(120,Math.min(620,availableWidth-(block.section?24:0)))}px`;
      card.style.zIndex = String(stored?.z ?? index);
      if (stored?.height) card.style.height = `${stored.height}px`;
      const grip = document.createElement('div'); grip.className = 'document-canvas-grip';
      if (block.type === 'heading') {
        const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'document-canvas-fold';
        fold.textContent = this.collapsed.has(block.id) ? '▸' : '▾';
        fold.title = this.collapsed.has(block.id) ? '展开章节' : '折叠章节';
        fold.setAttribute('aria-expanded', String(!this.collapsed.has(block.id)));
        fold.addEventListener('click', event => { event.stopPropagation(); this.collapsed.has(block.id) ? this.collapsed.delete(block.id) : this.collapsed.add(block.id); this.render(); });
        grip.append(fold);
      }
      grip.title='拖动只调整位置；进入章节接收区才关联';
      const label = document.createElement('span'); label.textContent = block.type === 'heading' ? `H${block.depth}` : '⠿'; grip.append(label);
      if(block.type==='heading'&&!this.options.readOnly){const drop=document.createElement('span');drop.className='canvas-section-drop';drop.dataset.parentTarget=block.id;drop.textContent='归入此章节';grip.append(drop);}
      card.append(grip);
      const content = document.createElement('div'); content.className = 'document-canvas-content';
      content.innerHTML = this.options.render(stripBlockIds(block.source));
      card.append(content);
      this.stage.append(card);
      const image=this.imageOnly(content)?content.querySelector<HTMLImageElement>('img'):null;
      if(image){
        const declaredWidth=parseFloat(image.style.width)||Number(image.getAttribute('width'))||undefined;
        card.classList.add('is-image');card.style.maxWidth='';if(stored?.width)card.style.width=`${stored.width}px`;
        const imageKey=image.currentSrc||image.src;
        const fit=()=>{const size=image.naturalWidth&&image.naturalHeight?{width:image.naturalWidth,height:image.naturalHeight}:this.imageSizes.get(imageKey);if(!size)return;this.imageSizes.set(imageKey,size);if(!stored?.width)card.style.width=`${Math.min(availableWidth,declaredWidth??size.width,620)+2}px`;image.style.width='100%';image.style.aspectRatio=`${size.width} / ${size.height}`;
          // 缓存图可能在隐藏标签中已经加载；真实宽度不能从隐藏节点的 0px 推导出 22px 高度。
          const width=content.clientWidth||Math.max(0,parseFloat(card.style.width)-2);if(!stored?.height)card.style.height=`${width*size.height/size.width+2}px`;this.stage.style.minHeight=`${Math.max(parseFloat(this.stage.style.minHeight)||500,parseFloat(card.style.top)+card.offsetHeight+100)}px`;
        };
        image.addEventListener('load',()=>{if(this.disposed||!this.stage.contains(card))return;const prior=this.imageSizes.get(imageKey),changed=!!image.naturalWidth&&!!image.naturalHeight&&(!prior||prior.width!==image.naturalWidth||prior.height!==image.naturalHeight);fit();if(changed){this.reflowIndex=Math.min(this.reflowIndex??index,index);this.render(this.hasExplicitChange);}});fit();
        if(!this.options.readOnly&&this.options.onReimportImage){content.title='单击重新导入图片';content.addEventListener('click',event=>{if(event.detail>1||this.layout.locked?.includes(block.id))return;event.preventDefault();event.stopPropagation();this.finishEditing();this.options.onReimportImage?.(block.id,block.source);});}
      }
      if (!this.options.readOnly) {
        grip.addEventListener('pointerdown', event => this.beginMove(event, block.id, card));
        card.addEventListener('click', event => {if(!(event.target as HTMLElement).closest('.canvas-inline-editor'))this.select(event, block.id);});
        // 引用单击优先导航；Alt 单击才进入引用文字编辑，普通正文仍直接编辑。
        content.addEventListener(this.options.inlineEditing?'click':'dblclick', event => {
          if(event.ctrlKey||event.metaKey||event.shiftKey||(event.target as HTMLElement).closest('button,input,textarea,.ProseMirror,.canvas-inline-editor')||this.editing?.id===block.id)return;
          if((event.target as HTMLElement).closest('a')&&!event.altKey)return;
          if(image||(this.options.inlineEditing&&!this.canEditBlock(block.id)))return;
          event.preventDefault();event.stopPropagation();this.select(event,block.id);this.edit(block,{left:event.clientX,top:event.clientY});
        },{capture:!!this.options.inlineEditing});
        const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'document-canvas-resize'; resize.title = '拖动调整内容块尺寸'; resize.setAttribute('aria-label', '调整尺寸');
        resize.addEventListener('pointerdown', event => this.beginResize(event, block.id, card)); card.append(resize);
      }
      cards.push({ block, index, card, width:card.offsetWidth,height: Math.max(68, card.offsetHeight), hidden: this.hidden(block, byId) });
    }
    for (const id of pendingAnchors) { const target = document.createElement('span'); target.id = id; target.className = 'document-canvas-anchor'; this.stage.append(target); }
    this.options.onRender?.(this.stage);
    // 隐藏画布的 offsetHeight 为零；离屏克隆只用于测量，不替换编辑器，也不修改公开正文。
    let measureHost:HTMLElement|undefined,measureStage:HTMLElement=this.stage;
    if(!this.stage.getClientRects().length){measureHost=document.createElement('div');measureHost.className='document-desktop markdown-preview document-canvas';Object.assign(measureHost.style,{position:'fixed',left:'-100000px',top:'0',width:`${this.measuredWidth}px`,height:'0',visibility:'hidden',pointerEvents:'none'});measureStage=this.stage.cloneNode(true) as HTMLElement;measureHost.append(measureStage);document.body.append(measureHost);}
    const measurements=new Map([...measureStage.children].filter((node):node is HTMLElement=>node instanceof HTMLElement&&!!node.dataset.blockId).map(node=>[node.dataset.blockId!,node]));
    for(const item of cards){const node=measurements.get(item.block.id)??item.card;item.width=Math.max(120,node.offsetWidth);item.height=Math.max(68,node.offsetHeight);}
    measureHost?.remove();
    const originals=new Map(cards.filter(item=>!!this.layout.blocks[item.block.id]).map(item=>[item.block.id,this.rawPosition(item.block,byId)]));
    const fixed=new Set(cards.filter(item=>originals.has(item.block.id)&&(!this.automaticPositions.has(item.block.id)||this.layout.locked?.includes(item.block.id)||Object.values(this.layout.groups??{}).some(members=>members.includes(item.block.id)))).map(item=>item.block.id));
    // 人工子块的父章节也作为锚点保留，防止父章节让位时间接移动人工坐标。
    for(const id of [...fixed]){let parent=byId.get(id)?.section;while(parent){fixed.add(parent);parent=byId.get(parent)?.section;}}
    const occupied=cards.filter(item=>fixed.has(item.block.id)||this.reflowIndex===undefined||item.index<this.reflowIndex).map(item=>({id:item.block.id,...originals.get(item.block.id)!,width:item.width,height:item.height})).filter(box=>Number.isFinite(box.x)&&Number.isFinite(box.y));
    const placed=new Map<string,{x:number;y:number}>();
    let previous:typeof cards[number]|undefined,layoutChanged=false;
    // 新块先接在原块／前块之后，再避让既有人工块；Markdown 顺序和章节归属不参与坐标改写。
    for(const item of cards){
      const {block}=item,stored=this.layout.blocks[block.id],prior=originals.get(block.id);
      const parent=block.section?(placed.get(block.section)??originals.get(block.section)):undefined;
      const needsPlacement=!stored||(this.reflowIndex!==undefined&&item.index>=this.reflowIndex&&!fixed.has(block.id)&&this.automaticPositions.has(block.id));
      let position=prior??{x:(parent?.x??8)+24,y:24};
      if(needsPlacement){
        const anchorId=this.insertionAnchors.get(block.id),anchor=anchorId?placed.get(anchorId):undefined,anchorBlock=anchorId?byId.get(anchorId):undefined;
        const preceding=previous?placed.get(previous.block.id):undefined;
        const sameParent=!!anchorBlock&&anchorBlock.section===block.section;
        position={x:prior?.x??(sameParent&&anchor?anchor.x:(parent?.x??8)+24),y:Math.max(prior?.y??24,preceding&&previous?preceding.y+previous.height+24:24)};
        // 避让只沿纵向寻找空位，不覆盖人工宽高、横向位置、层级或内容组。
        for(let attempt=0;attempt<=occupied.length;attempt++){const collisions=occupied.filter(box=>box.id!==block.id&&position.x<box.x+box.width+12&&position.x+item.width+12>box.x&&position.y<box.y+box.height+24&&position.y+item.height+24>box.y);if(!collisions.length)break;position.y=Math.max(...collisions.map(box=>box.y+box.height+24));}
        const next={...stored,x:position.x-(parent?.x??0),y:position.y-(parent?.y??0),...(block.section?{section:block.section}:{})};
        if(!block.section)delete next.section;
        layoutChanged||=!stored||JSON.stringify(next)!==JSON.stringify(stored);this.layout.blocks[block.id]=next;this.automaticPositions.add(block.id);
      }
      placed.set(block.id,position);if(!occupied.some(box=>box.id===block.id))occupied.push({id:block.id,...position,width:item.width,height:item.height});previous=item;
    }
    const reflowed=this.reflowIndex!==undefined;this.reflowIndex=undefined;this.insertionAnchors.clear();
    // 折叠只作用于显示偏移，真实排版使用上面的完整块高度。
    let naturalY = 24, compactY = 24;
    const shifts = new Map<string, number>();
    for (const item of cards) {
      const { block, card, height } = item;
      shifts.set(block.id, naturalY - compactY);
      naturalY += height + 24;
      if (!item.hidden) compactY += height + 24;
    }
    let maxY = 500, maxX = availableWidth;
    for (const item of cards) {
      const { block, card, height } = item;
      const stored = this.layout.blocks[block.id];
      const raw = stored ? this.rawPosition(block, byId) : { x: 32, y: item.index * 100 + 24 };
      card.style.left = `${raw.x}px`; card.style.top = `${raw.y - (shifts.get(block.id) ?? 0)}px`;
      card.hidden = item.hidden;
      if (!item.hidden) { maxY = Math.max(maxY, parseFloat(card.style.top) + height + 100); maxX = Math.max(maxX, raw.x + item.width + 24); }
    }
    this.stage.style.minHeight = `${maxY}px`; this.stage.style.minWidth = `${maxX}px`;
    // 首次自动布局不制造草稿，位置在显式修改时一起保存。
    if(publishLayout&&reflowed&&layoutChanged)this.emit();
  }

  private toolbar(): HTMLElement {
    const bar = document.createElement('div'); bar.className = 'document-canvas-toolbar';
    const action = (text: string, title: string, run: () => void) => {
      if(this.options.toolbarHost&&['删除','编辑','撤销','重做'].includes(text))return;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.title = title; button.addEventListener('click', run); bar.append(button);
    };
    action('适应', '把全部内容放入视野', () => this.fit());
    action('删除', '删除选中块及其章节内容', () => this.removeSelected());
    action('编辑', '编辑选中块的正文', () => { const block = this.blocks.find(item => this.selected.has(item.id)); if (block) this.edit(block); });
    const arrange=document.createElement('button');arrange.textContent=this.options.toolbarHost?'工具 ⋯':'排列 ⋯';arrange.onclick=()=>showAppMenu([
      {label:'编辑选中内容',disabled:!this.selected.size,run:()=>{const block=this.blocks.find(b=>this.selected.has(b.id));if(block)this.edit(block);}},
      {label:'删除选中内容',disabled:!this.selected.size,danger:true,run:()=>this.removeSelected()},
      {label:'撤销',shortcut:'Ctrl+Z',run:()=>this.undo()},{label:'重做',shortcut:'Ctrl+Y',run:()=>this.redo()},
      {label:this.ratio?'取消图片等比例缩放':'开启图片等比例缩放',separator:true,run:()=>{this.ratio=!this.ratio;this.refresh();}},
      {label:'靠左对齐',run:()=>this.align('left')},{label:'靠右对齐',run:()=>this.align('right')},
      {label:'前置一层',run:()=>this.layer(1)},{label:'后置一层',run:()=>this.layer(-1)},
      {label:'阅读顺序前移',separator:true,run:()=>this.moveReading(-1)},{label:'阅读顺序后移',run:()=>this.moveReading(1)},
      {label:'组成内容组',separator:true,disabled:this.selected.size<2,run:()=>{this.checkpoint();this.layout.groups??={};this.layout.groups['group-'+crypto.randomUUID()]=[...this.selected];this.emit();}},
      {label:'解散所选内容组',run:()=>{this.checkpoint();for(const [id,items] of Object.entries(this.layout.groups??{}))if(items.some(item=>this.selected.has(item)))delete this.layout.groups![id];this.emit();}},
      {label:'锁定 / 解锁选中块',run:()=>{this.checkpoint();const locked=new Set(this.layout.locked??[]),unlock=[...this.selected].every(id=>locked.has(id));this.selected.forEach(id=>unlock?locked.delete(id):locked.add(id));this.layout.locked=[...locked];this.emit();}},
      {label:this.snap?'关闭网格吸附':'开启网格吸附',separator:true,run:()=>{this.snap=!this.snap;}},
    ],arrange);bar.append(arrange);
    action('撤销', '撤销画布中的上一步操作', () => this.undo());
    action('重做', '重做画布中的下一步操作', () => this.redo());
    action('−','缩小画布',()=>{this.pan.scale=Math.max(.15,this.pan.scale/1.2);this.transform();});
    action('＋','放大画布',()=>{this.pan.scale=Math.min(2,this.pan.scale*1.2);this.transform();});
    const ratio = document.createElement('label'); ratio.className = 'document-canvas-ratio';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.ratio; checkbox.addEventListener('change', () => { this.ratio = checkbox.checked; });
    ratio.append(checkbox, ' 等比例缩放图片'); if(!this.options.toolbarHost)bar.append(ratio);
    return bar;
  }

  private select(event: MouseEvent | PointerEvent, id: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    else if (!this.selected.has(id)) { this.selected.clear(); this.selected.add(id); }
    const group=Object.values(this.layout.groups??{}).find(items=>items.includes(id));if(group)group.forEach(member=>this.selected.add(member));
    this.stage.querySelectorAll<HTMLElement>('[data-block-id]').forEach(item => item.classList.toggle('is-selected', this.selected.has(item.dataset.blockId ?? '')));
  }

  private beginMove(event: PointerEvent, id: string, card: HTMLElement) {
    if (this.options.readOnly || event.button !== 0 || this.layout.locked?.includes(id) || (event.target as HTMLElement).closest('button')) return;
    if(this.editing){this.finishEditing();return;}
    event.preventDefault(); this.root.focus({ preventScroll: true }); this.select(event, id);
    const byId = new Map(this.blocks.map(block => [block.id, block]));
    const hasSelectedAncestor = (block: DocumentBlock) => { let parent = block.section; while (parent) { if (this.selected.has(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const roots = [...this.selected].filter(selected => { const block = byId.get(selected); return block && !hasSelectedAncestor(block); });
    const affected = (block: DocumentBlock) => { if (roots.includes(block.id)) return true; let parent = block.section; while (parent) { if (roots.includes(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const cards = this.blocks.filter(affected).map(block => this.stage.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)).filter((item): item is HTMLElement => !!item);
    const originals = cards.map(item => ({ item, x: parseFloat(item.style.left), y: parseFloat(item.style.top) }));
    const startX = event.clientX, startY = event.clientY;
    const unlink=document.createElement('div');unlink.className='canvas-unlink-drop';unlink.textContent='移到文档直属内容 · 解除章节关联';this.viewport.append(unlink);this.stage.classList.add('is-dragging-block');
    let target:HTMLElement|undefined;
    const hit=(x:number,y:number)=>{target?.classList.remove('is-drop-target');target=undefined;const excluded=new Set(this.blocks.filter(affected).map(b=>b.id));for(const el of [unlink,...this.stage.querySelectorAll<HTMLElement>('[data-parent-target]')]){if(el.dataset.parentTarget&&excluded.has(el.dataset.parentTarget))continue;const r=el.getBoundingClientRect();if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom){target=el;break;}}target?.classList.add('is-drop-target');};
    card.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const dx = (next.clientX - startX)/this.pan.scale, dy = (next.clientY - startY)/this.pan.scale; for (const entry of originals) { entry.item.style.left = `${Math.round(entry.x + dx)}px`; entry.item.style.top = `${Math.round(entry.y + dy)}px`; }hit(next.clientX,next.clientY); };
    const cleanup = () => {unlink.remove();this.stage.classList.remove('is-dragging-block');target?.classList.remove('is-drop-target'); this.cancelGesture=undefined;window.removeEventListener('blur',cancel);card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', end); card.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); for (const entry of originals) { entry.item.style.left = `${entry.x}px`; entry.item.style.top = `${entry.y}px`; } };
    const end = (next: PointerEvent) => {
      cleanup();
      const dx = (next.clientX - startX)/this.pan.scale, dy = (next.clientY - startY)/this.pan.scale;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      // 手动移动后，所携带的章节子块全部退出自动让位，后续新增正文只避让它们。
      for(const entry of originals)this.automaticPositions.delete(entry.item.dataset.blockId!);
      if(target){try{let nextText=this.markdown;for(const root of roots)nextText=reparentDocumentBlock(nextText,root,target.dataset.parentTarget);this.applyStructure(nextText);}catch(error){this.render();window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error}));}return;}
      this.checkpoint();
      for (const blockId of roots) {
        const block = byId.get(blockId)!;
        const prior = this.layout.blocks[blockId];
        this.layout.blocks[blockId] = { ...prior, x: this.snap?Math.round((prior.x+dx)/12)*12:Math.round(prior.x+dx), y: this.snap?Math.round((prior.y+dy)/12)*12:Math.round(prior.y+dy), ...(block.section ? { section: block.section } : {}) };
      }
      this.emit(); this.render();
    };
    this.cancelGesture=cancel;window.addEventListener('blur',cancel);card.addEventListener('pointermove', move); card.addEventListener('pointerup', end); card.addEventListener('pointercancel', cancel);
  }

  private beginResize(event: PointerEvent, id: string, card: HTMLElement) {
    if (this.options.readOnly || event.button !== 0 || this.layout.locked?.includes(id)) return;
    event.preventDefault(); event.stopPropagation(); this.root.focus({ preventScroll: true }); this.selected.clear(); this.selected.add(id);
    const startX = event.clientX, startY = event.clientY, originalWidth = card.offsetWidth, originalHeight = card.offsetHeight;
    const originalMaxWidth=card.style.maxWidth;card.style.maxWidth='';
    const image = /!\[[^\]]*\]\(|<img\b/i.test(this.blocks.find(block => block.id === id)?.source ?? '');
    const handle = event.currentTarget as HTMLElement; handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const width = Math.max(180, originalWidth + (next.clientX - startX)/this.pan.scale);
      const height = image && this.ratio ? width * originalHeight / originalWidth : Math.max(70, originalHeight + (next.clientY - startY)/this.pan.scale);
      card.style.width = `${Math.round(width)}px`; card.style.height = `${Math.round(height)}px`;
    };
    const cleanup = () => { this.cancelGesture=undefined;window.removeEventListener('blur',cancel);handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); card.style.width = `${originalWidth}px`; card.style.height = `${originalHeight}px`;card.style.maxWidth=originalMaxWidth; };
    const end = () => { cleanup(); const width = Math.round(parseFloat(card.style.width)), height = Math.round(parseFloat(card.style.height)); if (Math.abs(width - originalWidth) + Math.abs(height - originalHeight) < 2) return; this.checkpoint(); this.layout.blocks[id] = { ...this.layout.blocks[id], x: this.layout.blocks[id]?.x ?? parseFloat(card.style.left), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top), width, height }; this.automaticPositions.delete(id);this.emit(); this.render(); };
    this.cancelGesture=cancel;window.addEventListener('blur',cancel);handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', cancel);
  }

  private align(side: 'left' | 'right') {
    if (this.options.readOnly || !this.selected.size) return;
    this.checkpoint();
    for (const id of this.selected) {
      const card = this.stage.querySelector<HTMLElement>(`[data-block-id="${id}"]`); if (!card) continue;
      const block = this.blocks.find(item => item.id === id)!;
      const parent = block.section ? this.stage.querySelector<HTMLElement>(`[data-block-id="${block.section}"]`) : null;
      const parentX = parent ? parseFloat(parent.style.left) : 0;
      const width = card.offsetWidth;
      const absoluteX = side === 'left' ? parentX + 24 : parentX + Math.max(24, (parent ? parent.offsetWidth : this.stage.clientWidth) - width - 24);
      this.layout.blocks[id] = { ...this.layout.blocks[id], x: Math.round(absoluteX - parentX), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top) - (parent ? parseFloat(parent.style.top) : 0), ...(block.section ? { section: block.section } : {}) };
      this.automaticPositions.delete(id);
    }
    this.emit(); this.render();
  }

  private layer(delta: number) {
    if (this.options.readOnly || !this.selected.size) return;
    this.checkpoint();
    for (const id of this.selected) {
      const card = this.stage.querySelector<HTMLElement>(`[data-block-id="${id}"]`); if (!card) continue;
      this.layout.blocks[id] = { ...this.layout.blocks[id], x: this.layout.blocks[id]?.x ?? parseFloat(card.style.left), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top), z: (this.layout.blocks[id]?.z ?? Number(card.style.zIndex)) + delta };
      this.automaticPositions.delete(id);
    }
    this.emit(); this.render();
  }

  /** 专用创作模块继续使用模块控件；普通正文、表格及代码都直接在视图里编辑。 */
  private canEditInline(block:DocumentBlock){return !!this.options.inlineEditing&&['heading','paragraph','list','table','blockquote','code'].includes(block.type)&&!/^```(?:cewen|design)/.test(block.source)&&!this.imageOnlySource(block.source);}
  private edit(block: DocumentBlock,point?:{left:number;top:number},readingHost?:HTMLElement) {
    if(this.options.readOnly||this.layout.locked?.includes(block.id))return;
    if(this.imageOnlySource(block.source)){this.finishEditing();this.options.onReimportImage?.(block.id,block.source);return;}
    if(this.canEditInline(block)){
      if(this.editing?.id===block.id)return;this.finishEditing();
      block=this.blocks.find(b=>b.id===block.id)??block;
      const host=readingHost??this.stage.querySelector<HTMLElement>(`[data-block-id="${block.id}"] .document-canvas-content`);if(!host)return;
      const original=this.markdown,originalBlocks=this.blocks.map(b=>({...b})),index=originalBlocks.findIndex(b=>b.id===block.id);
      let chunk=serializeDocumentBlocks('',[block]),last=block.source;
      // 在展示节点还存在时读取本段落的真实排版，只作用于此次原位编辑，不改变其他编辑器。
      const readingNode=host.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,pre,blockquote')??host,base=getComputedStyle(host),reading=getComputedStyle(readingNode);
      const properties=['font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','color'] as const;
      const baseStyle=properties.map(name=>[name,base.getPropertyValue(name)] as const),readingStyle=properties.map(name=>[name,reading.getPropertyValue(name)] as const);
      const margins={top:reading.getPropertyValue('margin-top'),bottom:reading.getPropertyValue('margin-bottom')};
      // Crepe 对内部 p、标题、列表标签及表格单元格分别设置几何样式，必须采样真实标签而不只覆盖直接首孩子。
      const nodeStyles:[string,string][]=[];
      for(const tag of ['p','h1','h2','h3','h4','h5','h6','li','td','th','table','ul','ol','blockquote','pre','code']){const node=host.matches(tag)?host:host.querySelector<HTMLElement>(tag);if(!node)continue;const css=getComputedStyle(node);for(const property of ['line-height','font-size','font-family','font-weight','font-style','letter-spacing','padding','margin','min-height'])nodeStyles.push([`--inline-${tag}-${property}`,css.getPropertyValue(property)]);}
      // 在替换内容前冻结自由块当前尺寸，进入 Milkdown 或源码回退都不会使块突然放大。
      const card=host.closest<HTMLElement>('.document-canvas-block');if(card){
        // 先同时读取尺寸再写入，保留自然宽度的亚像素；先写整数宽度会让临界文本换行后才读到变大的高度。
        const size=getComputedStyle(card),width=size.width,height=size.height;
        Object.assign(card.style,{width,height});card.classList.add('is-editing');
      }
      const editor=document.createElement('div');editor.className='canvas-inline-editor';if(readingHost)editor.classList.add('document-inline-writing');host.replaceChildren(editor);
      for(const [name,value] of baseStyle)editor.style.setProperty(name,value);for(const [name,value] of readingStyle)editor.style.setProperty(`--inline-reading-${name}`,value);editor.style.setProperty('--inline-reading-margin-top',margins.top);editor.style.setProperty('--inline-reading-margin-bottom',margins.bottom);editor.style.setProperty('--crepe-base-font-size',base.fontSize);
      for(const [name,value] of nodeStyles)editor.style.setProperty(name,value);
      // 富文本异步创建期间用户可能已开始输入或选词，完成创建后不能再把光标送回最初的单击点。
      let interacted=false;for(const type of ['pointerdown','keydown','beforeinput','compositionstart'])editor.addEventListener(type,()=>{interacted=true;},{capture:true,once:true});
      const state={id:block.id,host:editor,changed:false,read:()=>last,update:(text:string)=>{
        // 只接收当前存活会话的输入，已切块或销毁后的异步回调不能回写旧段落。
        if(this.disposed||this.editing!==state||this.options.readOnly)return;const clean=stripBlockIds(text).trimEnd();if(clean===last.trimEnd())return;
        if(!state.changed){this.checkpoint();state.changed=true;}last=clean;
        chunk=transferBlockIds(chunk,clean);const parts=parseDocumentBlocks(chunk);if(parts[0])parts[0].id=block.id;
        const stack:DocumentBlock[]=[];
        for(const part of parts){if(part.type==='heading'){while(stack.length&&(stack.at(-1)!.depth??1)>=(part.depth??1))stack.pop();part.section=stack.at(-1)?.id??block.section;stack.push(part);}else part.section=stack.at(-1)?.id??block.section;}
        chunk=serializeDocumentBlocks('',parts);
        // 分裂产生的新身份沿原块锚点落位；第一次输入就登记待排版，完成编辑后按真实块高让位。
        for(const part of parts)if(!this.layout.blocks[part.id])this.insertionAnchors.set(part.id,block.id);
        this.reflowIndex=Math.min(this.reflowIndex??index,index);
        const next=[...originalBlocks.slice(0,index),...parts,...originalBlocks.slice(index+1)].map(b=>({...b}));
        // 标题转正文／删除时提升其原子块；不把仍然存在的引用身份分配给邻段。
        if(parts[0]?.type!=='heading')for(const b of next)if(b.section===block.id)b.section=block.section;
        const oldById=new Map(this.blocks.map(b=>[b.id,b])),positions=new Map(this.blocks.map(b=>[b.id,this.rawPosition(b,oldById)]));
        this.markdown=serializeDocumentBlocks(original,next);this.blocks=parseDocumentBlocks(this.markdown);
        for(const part of this.blocks){const pos=positions.get(part.id),entry=this.layout.blocks[part.id],parent=part.section?positions.get(part.section):undefined;if(entry&&pos){entry.x=pos.x-(parent?.x??0);entry.y=pos.y-(parent?.y??0);if(part.section)entry.section=part.section;else delete entry.section;}}
        this.emit();
      },rich:undefined as RichWriting|undefined,ready:undefined as Promise<void>|undefined};
      this.editing=state;
      const rich=new RichWriting(editor,block.source,text=>state.update(text),async()=>{throw new Error('请在视图中右键“插入图片”导入媒体。');},url=>url,()=>this.options.onLink?.(),{singleBlock:!readingHost,inlineBreaks:true,contextInsertion:true});state.rich=rich;state.read=()=>rich.read();
      state.ready=rich.create().then(()=>{if(this.editing===state&&!interacted){if(point)rich.focusAt(point);else rich.focus();}}).catch(()=>{
        if(this.editing!==state)return;rich.dispose();state.rich=undefined;const input=document.createElement('textarea');input.className='canvas-inline-source';input.setAttribute('aria-label','原位编辑 Markdown');input.value=last;editor.replaceChildren(input);input.oninput=()=>{if(!input.matches('[data-composing]'))state.update(input.value);};input.addEventListener('compositionstart',()=>input.dataset.composing='true');input.addEventListener('compositionend',()=>{delete input.dataset.composing;state.update(input.value);});state.read=()=>input.value;input.focus();
        for(const [name,value] of readingStyle)input.style.setProperty(name,value);
        if(!readingHost&&block.type!=='code'){
          // 无损源码回退也遵守最小块：换行与多段粘贴留在原块，不能绕过富文本限制新增邻块。
          const put=(text:string)=>{input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');state.update(input.value);};
          input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();put('<br>');}});
          input.addEventListener('paste',event=>{const text=event.clipboardData?.getData('text/plain');if(text===undefined)return;event.preventDefault();put(text.replace(/\r\n?|\n/g,'<br>'));});
        }
      });
      // 焦点可以移到字体浮层、菜单或主题按钮；失焦不代表完成，切块、切视图、保存及锁定负责明确收尾。
      editor.addEventListener('click',event=>{if(event.altKey&&(event.target as HTMLElement).closest('a')){event.preventDefault();event.stopPropagation();}});
      editor.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing){event.preventDefault();this.finishEditing();}});
      return;
    }
    this.options.onEditBlock?.(block.id, block.source, nextSource => {
      if(this.options.readOnly)return;
      const current = parseDocumentBlocks(this.markdown).find(item => item.id === block.id);
      if (!current) return;
      if (stripBlockIds(nextSource) === current.source) return;
      this.checkpoint();
      this.markdown = this.markdown.slice(0, current.sourceStart) + stripBlockIds(nextSource) + this.markdown.slice(current.end);
      this.emit(); this.render();
    });
  }

  /** 阅读顺序命令复用显式归属规则，不从标题层级猜测相邻子树。 */
  private moveReading(direction:-1|1){
    if(this.selected.size!==1)return;const id=[...this.selected][0],chosen=this.blocks.find(b=>b.id===id);if(!chosen)return;
    const siblings=this.blocks.filter(b=>b.section===chosen.section),at=siblings.findIndex(b=>b.id===id),other=siblings[at+direction];if(!other)return;
    const targets=direction>0?this.blocks.filter(b=>blockSubtree(this.blocks,other.id).has(b.id)):[];
    this.reorder(id,targets.at(-1)?.id??other.id,direction>0);
  }
}
