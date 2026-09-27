import type { LayoutCompanion } from '../shared/document-companion.ts';
import { ensureBlockIds, parseDocumentBlocks, stripBlockIds, type DocumentBlock } from '../shared/document-blocks.ts';
import './document-canvas.css';
import { showAppMenu } from './app-menu';

export interface DocumentCanvasOptions {
  markdown: string;
  layout: LayoutCompanion;
  /** 渲染器必须返回已过滤的安全 HTML；画布不执行原始 Markdown 内的 HTML。 */
  render(markdown: string): string;
  onChange(markdown: string, layout: LayoutCompanion): void;
  onEditBlock?: (id: string, source: string, done: (nextSource: string) => void) => void;
  onRender?: (host: HTMLElement) => void;
  onInsert?: () => void;
  /** 阅读页使用现有公开布局；不补身份标记，也不写入草稿。 */
  readOnly?: boolean;
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
  private past: { markdown: string; layout: LayoutCompanion }[] = [];
  private future: { markdown: string; layout: LayoutCompanion }[] = [];
  private readonly keydown = (event: KeyboardEvent) => {
    if(event.key==='Escape'){this.cancelGesture?.();return;}
    const target = event.target as HTMLElement;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
    else if (event.key.toLowerCase() === 'y') { event.preventDefault(); this.redo(); }
  };

  constructor(private host: HTMLElement, private options: DocumentCanvasOptions) {
    this.markdown = options.readOnly ? options.markdown : ensureBlockIds(options.markdown);
    this.layout = structuredClone(options.layout);
    this.root.className = `document-canvas${options.readOnly ? ' is-read-only' : ''}`;
    this.root.tabIndex = options.readOnly ? -1 : 0;
    if (!options.readOnly) this.root.addEventListener('keydown', this.keydown);
    this.stage.className = 'document-canvas-stage';
    this.viewport.className = 'document-canvas-viewport';
    this.viewport.addEventListener('pointerdown', event => this.backgroundGesture(event));
    this.viewport.addEventListener('contextmenu', event => {
      event.preventDefault(); if(this.options.readOnly)return;
      if(this.suppressContext){this.suppressContext=false;return;}
      const id=(event.target as HTMLElement).closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      if(id&&!this.selected.has(id))this.select(event,id);
      showAppMenu([
        {label:'插入模块…',run:()=>this.options.onInsert?.()},
        {label:'编辑内容',disabled:!this.selected.size,run:()=>{const block=this.blocks.find(b=>this.selected.has(b.id));if(block)this.edit(block);}},
        {label:'删除选中内容',danger:true,disabled:!this.selected.size,run:()=>this.removeSelected()},
        {label:'适应画布',run:()=>this.fit()},
      ],this.viewport,{x:event.clientX,y:event.clientY});
    });
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
    if(markdown===this.markdown&&JSON.stringify(layout)===JSON.stringify(this.layout))return;
    this.checkpoint();this.markdown=ensureBlockIds(markdown);this.layout=structuredClone(layout);this.emit();this.render();
  }
  refresh(){this.render();}
  /** 大纲与查找定位只移动视口，不改变布局和阅读顺序。 */
  locate(id:string){const block=this.stage.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);if(!block)return;this.pan={x:20-block.offsetLeft,y:20-block.offsetTop,scale:1};this.transform();}
  find(query:string){const block=[...this.stage.querySelectorAll<HTMLElement>('[data-block-id]')].find(b=>b.textContent?.toLowerCase().includes(query.toLowerCase()));if(block)this.locate(block.dataset.blockId!);return !!block;}
  append(markdown:string) {this.replace(this.markdown.trimEnd()+'\n\n'+markdown.trim()+'\n');}
  private transform(){this.stage.style.transform=`translate(${this.pan.x}px,${this.pan.y}px) scale(${this.pan.scale})`;}
  fit(){const bounds=[...this.stage.querySelectorAll<HTMLElement>('[data-block-id]:not([hidden])')];const maxX=Math.max(600,...bounds.map(b=>b.offsetLeft+b.offsetWidth)),maxY=Math.max(300,...bounds.map(b=>b.offsetTop+b.offsetHeight));this.pan={x:20,y:20,scale:Math.min(1,(this.viewport.clientWidth-40)/maxX,(this.viewport.clientHeight-40)/maxY)};this.transform();}
  private removeSelected(){if(this.options.readOnly||!this.selected.size)return;const selected=new Set(this.selected);for(const b of this.blocks)if(b.section&&selected.has(b.section))selected.add(b.id);this.checkpoint();for(const b of [...this.blocks].reverse())if(selected.has(b.id)){this.markdown=this.markdown.slice(0,b.start)+this.markdown.slice(b.end);delete this.layout.blocks[b.id];}this.selected.clear();this.emit();this.render();}
  /** 空白左拖平移、右拖框选；内容内部的手势由对应编辑器负责。 */
  private backgroundGesture(event:PointerEvent){
    if(event.button!==0&&event.button!==2)return;
    if((event.target as HTMLElement).closest('.document-canvas-block'))return;
    event.preventDefault();this.root.focus({preventScroll:true});const start={x:event.clientX,y:event.clientY},pan={...this.pan};let moved=false;
    const box=document.createElement('div');box.className='canvas-marquee';this.viewport.setPointerCapture(event.pointerId);
    const move=(e:PointerEvent)=>{if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<6&&!moved)return;moved=true;if(event.button===0){this.pan.x=pan.x+e.clientX-start.x;this.pan.y=pan.y+e.clientY-start.y;this.transform();}else{this.viewport.append(box);const r=this.viewport.getBoundingClientRect();Object.assign(box.style,{left:Math.min(start.x,e.clientX)-r.left+'px',top:Math.min(start.y,e.clientY)-r.top+'px',width:Math.abs(e.clientX-start.x)+'px',height:Math.abs(e.clientY-start.y)+'px'});}};
    const cleanup=()=>{this.cancelGesture=undefined;window.removeEventListener('blur',cancel);this.viewport.removeEventListener('pointermove',move);this.viewport.removeEventListener('pointerup',up);this.viewport.removeEventListener('pointercancel',cancel);box.remove();};
    const cancel=()=>{this.pan=pan;this.transform();cleanup();};
    const up=(e:PointerEvent)=>{if(event.button===2&&moved){this.suppressContext=true;setTimeout(()=>this.suppressContext=false,350);if(!event.ctrlKey&&!event.shiftKey)this.selected.clear();const x1=Math.min(start.x,e.clientX),x2=Math.max(start.x,e.clientX),y1=Math.min(start.y,e.clientY),y2=Math.max(start.y,e.clientY);this.stage.querySelectorAll<HTMLElement>('[data-block-id]:not([hidden])').forEach(card=>{const r=card.getBoundingClientRect();if(r.right>=x1&&r.left<=x2&&r.bottom>=y1&&r.top<=y2)this.selected.add(card.dataset.blockId!);card.classList.toggle('is-selected',this.selected.has(card.dataset.blockId!));});}cleanup();};
    this.cancelGesture=cancel;window.addEventListener('blur',cancel);this.viewport.addEventListener('pointermove',move);this.viewport.addEventListener('pointerup',up);this.viewport.addEventListener('pointercancel',cancel);
  }

  /** 返回可供同批次提交的正文与公开排版；读取不会改变用户稿。 */
  read() { return { markdown: this.markdown, layout: structuredClone(this.layout) }; }
  dispose() { this.cancelGesture?.();this.disposed = true; this.root.removeEventListener('keydown', this.keydown); this.host.replaceChildren(); this.selected.clear(); }

  /** 每次显式操作只保存一个前态；首次自动排版不占用户撤销步。 */
  private checkpoint() { this.past.push(this.read()); if (this.past.length > 80) this.past.shift(); this.future = []; }
  undo() { const prior = this.past.pop(); if (!prior) return; this.future.push(this.read()); this.markdown = prior.markdown; this.layout = prior.layout; this.emit(); this.render(); }
  redo() { const next = this.future.pop(); if (!next) return; this.past.push(this.read()); this.markdown = next.markdown; this.layout = next.layout; this.emit(); this.render(); }

  private emit() { if (!this.options.readOnly) this.options.onChange(this.markdown, structuredClone(this.layout)); }
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

  private render() {
    if (this.disposed) return;
    this.blocks = parseDocumentBlocks(this.markdown);
    const byId = new Map(this.blocks.map(block => [block.id, block]));
    this.root.replaceChildren();
    if (!this.options.readOnly) this.root.append(this.toolbar());
    this.stage.replaceChildren(); this.viewport.replaceChildren(this.stage);this.root.append(this.viewport);this.transform();
    const cards: { block: DocumentBlock; index: number; card: HTMLElement; height: number; hidden: boolean }[] = [];
    const availableWidth = Math.max(120, this.host.clientWidth - 72);
    const pendingAnchors: string[] = [];
    for (const [index, block] of this.blocks.entries()) {
      // Markdown 引用定义只是链接元信息，保留原文但不生成一张空白纸面卡片。
      if (block.type === 'definition') continue;
      const anchor = block.type === 'html' ? /^<a\s+id=["']([A-Za-z0-9_-]+)["']\s*>\s*<\/a>\s*$/i.exec(block.source.trim()) : null;
      if (anchor) { pendingAnchors.push(anchor[1]); continue; }
      if (!block.id) continue;
      const stored = this.layout.blocks[block.id];
      const card = document.createElement('article');
      card.className = `document-canvas-block${block.type === 'heading' ? ' is-heading' : ''}${this.selected.has(block.id) ? ' is-selected' : ''}`;
      card.dataset.blockId = block.id;
      for (const id of pendingAnchors.splice(0)) { const target = document.createElement('span'); target.id = id; target.className = 'document-canvas-anchor'; card.append(target); }
      card.style.left = '0px'; card.style.top = '0px';
      card.style.width = `${stored?.width ?? Math.min(620, availableWidth - (block.section ? 24 : 0))}px`;
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
      const label = document.createElement('span'); label.textContent = block.type === 'heading' ? `章节 · ${block.depth} 级` : block.type === 'paragraph' && /!\[[^\]]*\]\(/.test(block.source) ? '图片与正文' : '内容块'; grip.append(label);
      card.append(grip);
      const content = document.createElement('div'); content.className = 'document-canvas-content';
      content.innerHTML = this.options.render(stripBlockIds(block.source));
      card.append(content);
      if (!this.options.readOnly) {
        grip.addEventListener('pointerdown', event => this.beginMove(event, block.id, card));
        card.addEventListener('click', event => this.select(event, block.id));
        card.addEventListener('dblclick', event => { if ((event.target as HTMLElement).closest('button,a,input,textarea')) return; this.edit(block); });
        const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'document-canvas-resize'; resize.title = '拖动调整内容块尺寸'; resize.setAttribute('aria-label', '调整尺寸');
        resize.addEventListener('pointerdown', event => this.beginResize(event, block.id, card)); card.append(resize);
      }
      this.stage.append(card);
      cards.push({ block, index, card, height: Math.max(68, card.offsetHeight), hidden: this.hidden(block, byId) });
    }
    for (const id of pendingAnchors) { const target = document.createElement('span'); target.id = id; target.className = 'document-canvas-anchor'; this.stage.append(target); }
    this.options.onRender?.(this.stage);
    for (const item of cards) item.height = Math.max(68, item.card.offsetHeight);
    // 首次进入排版时，按真实渲染高度建立布局；之后折叠仅作用于显示偏移。
    let naturalY = 24, compactY = 24, changed = false;
    const shifts = new Map<string, number>();
    for (const item of cards) {
      const { block, card, height } = item;
      const parent = block.section ? byId.get(block.section) : undefined;
      if (!this.layout.blocks[block.id]) {
        const parentRaw = parent ? this.rawPosition(parent, byId) : { x: 0, y: 0 };
        const desiredX = parent ? parentRaw.x + 24 : 32;
        this.layout.blocks[block.id] = { x: desiredX - parentRaw.x, y: naturalY - parentRaw.y, width: parseFloat(card.style.width), ...(block.section ? { section: block.section } : {}) };
        changed ||= !this.options.readOnly;
      }
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
      if (!item.hidden) { maxY = Math.max(maxY, parseFloat(card.style.top) + height + 100); maxX = Math.max(maxX, raw.x + parseFloat(card.style.width) + 24); }
    }
    this.stage.style.minHeight = `${maxY}px`; this.stage.style.minWidth = `${maxX}px`;
    // 首次自动布局不制造草稿，位置在显式修改时一起保存。
  }

  private toolbar(): HTMLElement {
    const bar = document.createElement('div'); bar.className = 'document-canvas-toolbar';
    const action = (text: string, title: string, run: () => void) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.title = title; button.addEventListener('click', run); bar.append(button);
    };
    action('＋ 插入', '插入文字或通用模块', () => this.options.onInsert?.());
    action('适应', '把全部内容放入视野', () => this.fit());
    action('删除', '删除选中块及其章节内容', () => this.removeSelected());
    action('编辑', '编辑选中块的正文', () => { const block = this.blocks.find(item => this.selected.has(item.id)); if (block) this.edit(block); });
    const arrange=document.createElement('button');arrange.textContent='排列 ⋯';arrange.onclick=()=>showAppMenu([
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
    ratio.append(checkbox, ' 等比例缩放图片'); bar.append(ratio);
    return bar;
  }

  private select(event: MouseEvent | PointerEvent, id: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    else if (!this.selected.has(id)) { this.selected.clear(); this.selected.add(id); }
    const group=Object.values(this.layout.groups??{}).find(items=>items.includes(id));if(group)group.forEach(member=>this.selected.add(member));
    this.stage.querySelectorAll<HTMLElement>('[data-block-id]').forEach(item => item.classList.toggle('is-selected', this.selected.has(item.dataset.blockId ?? '')));
  }

  private beginMove(event: PointerEvent, id: string, card: HTMLElement) {
    if (event.button !== 0 || this.layout.locked?.includes(id) || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault(); this.root.focus({ preventScroll: true }); this.select(event, id);
    const byId = new Map(this.blocks.map(block => [block.id, block]));
    const hasSelectedAncestor = (block: DocumentBlock) => { let parent = block.section; while (parent) { if (this.selected.has(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const roots = [...this.selected].filter(selected => { const block = byId.get(selected); return block && !hasSelectedAncestor(block); });
    const affected = (block: DocumentBlock) => { if (roots.includes(block.id)) return true; let parent = block.section; while (parent) { if (roots.includes(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const cards = this.blocks.filter(affected).map(block => this.stage.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)).filter((item): item is HTMLElement => !!item);
    const originals = cards.map(item => ({ item, x: parseFloat(item.style.left), y: parseFloat(item.style.top) }));
    const startX = event.clientX, startY = event.clientY;
    card.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const dx = (next.clientX - startX)/this.pan.scale, dy = (next.clientY - startY)/this.pan.scale; for (const entry of originals) { entry.item.style.left = `${Math.round(entry.x + dx)}px`; entry.item.style.top = `${Math.round(entry.y + dy)}px`; } };
    const cleanup = () => { this.cancelGesture=undefined;window.removeEventListener('blur',cancel);card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', end); card.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); for (const entry of originals) { entry.item.style.left = `${entry.x}px`; entry.item.style.top = `${entry.y}px`; } };
    const end = (next: PointerEvent) => {
      cleanup();
      const dx = (next.clientX - startX)/this.pan.scale, dy = (next.clientY - startY)/this.pan.scale;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
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
    if (event.button !== 0 || this.layout.locked?.includes(id)) return;
    event.preventDefault(); event.stopPropagation(); this.root.focus({ preventScroll: true }); this.selected.clear(); this.selected.add(id);
    const startX = event.clientX, startY = event.clientY, originalWidth = card.offsetWidth, originalHeight = card.offsetHeight;
    const image = /!\[[^\]]*\]\(|<img\b/i.test(this.blocks.find(block => block.id === id)?.source ?? '');
    const handle = event.currentTarget as HTMLElement; handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const width = Math.max(180, originalWidth + (next.clientX - startX)/this.pan.scale);
      const height = image && this.ratio ? width * originalHeight / originalWidth : Math.max(70, originalHeight + (next.clientY - startY)/this.pan.scale);
      card.style.width = `${Math.round(width)}px`; card.style.height = `${Math.round(height)}px`;
    };
    const cleanup = () => { this.cancelGesture=undefined;window.removeEventListener('blur',cancel);handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); card.style.width = `${originalWidth}px`; card.style.height = `${originalHeight}px`; };
    const end = () => { cleanup(); const width = Math.round(parseFloat(card.style.width)), height = Math.round(parseFloat(card.style.height)); if (Math.abs(width - originalWidth) + Math.abs(height - originalHeight) < 2) return; this.checkpoint(); this.layout.blocks[id] = { ...this.layout.blocks[id], x: this.layout.blocks[id]?.x ?? parseFloat(card.style.left), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top), width, height }; this.emit(); this.render(); };
    this.cancelGesture=cancel;window.addEventListener('blur',cancel);handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', cancel);
  }

  private align(side: 'left' | 'right') {
    if (!this.selected.size) return;
    this.checkpoint();
    for (const id of this.selected) {
      const card = this.stage.querySelector<HTMLElement>(`[data-block-id="${id}"]`); if (!card) continue;
      const block = this.blocks.find(item => item.id === id)!;
      const parent = block.section ? this.stage.querySelector<HTMLElement>(`[data-block-id="${block.section}"]`) : null;
      const parentX = parent ? parseFloat(parent.style.left) : 0;
      const width = parseFloat(card.style.width);
      const absoluteX = side === 'left' ? parentX + 24 : parentX + Math.max(24, (parent ? parseFloat(parent.style.width) : this.stage.clientWidth) - width - 24);
      this.layout.blocks[id] = { ...this.layout.blocks[id], x: Math.round(absoluteX - parentX), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top) - (parent ? parseFloat(parent.style.top) : 0), width, ...(block.section ? { section: block.section } : {}) };
    }
    this.emit(); this.render();
  }

  private layer(delta: number) {
    if (!this.selected.size) return;
    this.checkpoint();
    for (const id of this.selected) {
      const card = this.stage.querySelector<HTMLElement>(`[data-block-id="${id}"]`); if (!card) continue;
      this.layout.blocks[id] = { ...this.layout.blocks[id], x: this.layout.blocks[id]?.x ?? parseFloat(card.style.left), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top), z: (this.layout.blocks[id]?.z ?? Number(card.style.zIndex)) + delta };
    }
    this.emit(); this.render();
  }

  private edit(block: DocumentBlock) {
    this.options.onEditBlock?.(block.id, block.source, nextSource => {
      const current = parseDocumentBlocks(this.markdown).find(item => item.id === block.id);
      if (!current) return;
      if (stripBlockIds(nextSource) === current.source) return;
      this.checkpoint();
      this.markdown = this.markdown.slice(0, current.sourceStart) + stripBlockIds(nextSource) + this.markdown.slice(current.end);
      this.emit(); this.render();
    });
  }

  /** 章节连同下级标题和内容移动；拖拽从不触发此操作。 */
  private moveReading(direction: -1 | 1) {
    if (this.selected.size !== 1) return;
    const index = this.blocks.findIndex(block => this.selected.has(block.id)); if (index < 0) return;
    const blocks = this.blocks, chosen = blocks[index];
    const end = chosen.type === 'heading' ? blocks.findIndex((block, at) => at > index && block.type === 'heading' && (block.depth ?? 7) <= (chosen.depth ?? 7)) : index + 1;
    const chosenEnd = end < 0 ? blocks.length : end;
    const units: { start: number; end: number; section?: string }[] = [];
    for (let at = 0; at < blocks.length;) {
      const block = blocks[at];
      if (block.section !== chosen.section) { at++; continue; }
      const next = block.type === 'heading' ? blocks.findIndex((item, later) => later > at && item.type === 'heading' && (item.depth ?? 7) <= (block.depth ?? 7)) : at + 1;
      const until = next < 0 ? blocks.length : next;
      units.push({ start: at, end: until, section: block.section }); at = until;
    }
    // 同一所属章节内交换完整块组；子章节整体移动，不拆散其下级内容。
    const siblings = units;
    const own = siblings.findIndex(unit => unit.start === index && unit.end === chosenEnd);
    const other = siblings[own + direction]; if (own < 0 || !other) return;
    const chunks = blocks.map((block, at) => this.markdown.slice(block.start, blocks[at + 1]?.start ?? this.markdown.length));
    const a = { start: index, end: chosenEnd }, b = other;
    const first = direction < 0 ? b : a, second = direction < 0 ? a : b;
    if (first.end !== second.start) return;
    this.checkpoint();
    const reordered = [...chunks.slice(0, first.start), ...chunks.slice(second.start, second.end), ...chunks.slice(first.start, first.end), ...chunks.slice(second.end)];
    this.markdown = this.markdown.slice(0, blocks[0].start) + reordered.join('');
    this.emit(); this.render();
  }
}
