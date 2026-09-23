import type { LayoutCompanion } from '../shared/document-companion.ts';
import { ensureBlockIds, parseDocumentBlocks, stripBlockIds, type DocumentBlock } from '../shared/document-blocks.ts';
import './document-canvas.css';

export interface DocumentCanvasOptions {
  markdown: string;
  layout: LayoutCompanion;
  /** 渲染器必须返回已过滤的安全 HTML；画布不执行原始 Markdown 内的 HTML。 */
  render(markdown: string): string;
  onChange(markdown: string, layout: LayoutCompanion): void;
  onEditBlock?: (id: string, source: string, done: (nextSource: string) => void) => void;
  onRender?: (host: HTMLElement) => void;
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
  private ratio = true;
  private disposed = false;
  private past: { markdown: string; layout: LayoutCompanion }[] = [];
  private future: { markdown: string; layout: LayoutCompanion }[] = [];
  private readonly keydown = (event: KeyboardEvent) => {
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
    this.host.replaceChildren(this.root);
    this.render();
  }

  /** 返回可供同批次提交的正文与公开排版；读取不会改变用户稿。 */
  read() { return { markdown: this.markdown, layout: structuredClone(this.layout) }; }
  dispose() { this.disposed = true; this.root.removeEventListener('keydown', this.keydown); this.host.replaceChildren(); this.selected.clear(); }

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
    this.stage.replaceChildren(); this.root.append(this.stage);
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
      cards.push({ block, index, card, height: Math.max(68, card.getBoundingClientRect().height), hidden: this.hidden(block, byId) });
    }
    for (const id of pendingAnchors) { const target = document.createElement('span'); target.id = id; target.className = 'document-canvas-anchor'; this.stage.append(target); }
    this.options.onRender?.(this.stage);
    for (const item of cards) item.height = Math.max(68, item.card.getBoundingClientRect().height);
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
    if (changed) this.emit();
  }

  private toolbar(): HTMLElement {
    const bar = document.createElement('div'); bar.className = 'document-canvas-toolbar';
    const action = (text: string, title: string, run: () => void) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.title = title; button.addEventListener('click', run); bar.append(button);
    };
    action('编辑', '编辑选中块的正文', () => { const block = this.blocks.find(item => this.selected.has(item.id)); if (block) this.edit(block); });
    action('靠左', '将选中块对齐所属章节左侧', () => this.align('left'));
    action('靠右', '将选中块对齐所属章节右侧', () => this.align('right'));
    action('上层', '将选中块前置一层', () => this.layer(1));
    action('下层', '将选中块后置一层', () => this.layer(-1));
    action('阅读前移', '明确改变 Markdown 阅读顺序', () => this.moveReading(-1));
    action('阅读后移', '明确改变 Markdown 阅读顺序', () => this.moveReading(1));
    action('撤销', '撤销画布中的上一步操作', () => this.undo());
    action('重做', '重做画布中的下一步操作', () => this.redo());
    const ratio = document.createElement('label'); ratio.className = 'document-canvas-ratio';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.ratio; checkbox.addEventListener('change', () => { this.ratio = checkbox.checked; });
    ratio.append(checkbox, ' 等比例缩放图片'); bar.append(ratio);
    return bar;
  }

  private select(event: MouseEvent | PointerEvent, id: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    else if (!this.selected.has(id)) { this.selected.clear(); this.selected.add(id); }
    this.stage.querySelectorAll<HTMLElement>('[data-block-id]').forEach(item => item.classList.toggle('is-selected', this.selected.has(item.dataset.blockId ?? '')));
  }

  private beginMove(event: PointerEvent, id: string, card: HTMLElement) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault(); this.root.focus({ preventScroll: true }); this.select(event, id);
    const byId = new Map(this.blocks.map(block => [block.id, block]));
    const hasSelectedAncestor = (block: DocumentBlock) => { let parent = block.section; while (parent) { if (this.selected.has(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const roots = [...this.selected].filter(selected => { const block = byId.get(selected); return block && !hasSelectedAncestor(block); });
    const affected = (block: DocumentBlock) => { if (roots.includes(block.id)) return true; let parent = block.section; while (parent) { if (roots.includes(parent)) return true; parent = byId.get(parent)?.section; } return false; };
    const cards = this.blocks.filter(affected).map(block => this.stage.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)).filter((item): item is HTMLElement => !!item);
    const originals = cards.map(item => ({ item, x: parseFloat(item.style.left), y: parseFloat(item.style.top) }));
    const startX = event.clientX, startY = event.clientY;
    card.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const dx = next.clientX - startX, dy = next.clientY - startY; for (const entry of originals) { entry.item.style.left = `${Math.round(entry.x + dx)}px`; entry.item.style.top = `${Math.round(entry.y + dy)}px`; } };
    const cleanup = () => { card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', end); card.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); for (const entry of originals) { entry.item.style.left = `${entry.x}px`; entry.item.style.top = `${entry.y}px`; } };
    const end = (next: PointerEvent) => {
      cleanup();
      const dx = next.clientX - startX, dy = next.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      this.checkpoint();
      for (const blockId of roots) {
        const block = byId.get(blockId)!;
        const prior = this.layout.blocks[blockId];
        this.layout.blocks[blockId] = { ...prior, x: Math.round(prior.x + dx), y: Math.round(prior.y + dy), ...(block.section ? { section: block.section } : {}) };
      }
      this.emit(); this.render();
    };
    card.addEventListener('pointermove', move); card.addEventListener('pointerup', end); card.addEventListener('pointercancel', cancel);
  }

  private beginResize(event: PointerEvent, id: string, card: HTMLElement) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.root.focus({ preventScroll: true }); this.selected.clear(); this.selected.add(id);
    const startX = event.clientX, startY = event.clientY, originalWidth = card.getBoundingClientRect().width, originalHeight = card.getBoundingClientRect().height;
    const image = /!\[[^\]]*\]\(|<img\b/i.test(this.blocks.find(block => block.id === id)?.source ?? '');
    const handle = event.currentTarget as HTMLElement; handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const width = Math.max(180, originalWidth + next.clientX - startX);
      const height = image && this.ratio ? width * originalHeight / originalWidth : Math.max(70, originalHeight + next.clientY - startY);
      card.style.width = `${Math.round(width)}px`; card.style.height = `${Math.round(height)}px`;
    };
    const cleanup = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', cancel); };
    const cancel = () => { cleanup(); card.style.width = `${originalWidth}px`; card.style.height = `${originalHeight}px`; };
    const end = () => { cleanup(); const width = Math.round(parseFloat(card.style.width)), height = Math.round(parseFloat(card.style.height)); if (Math.abs(width - originalWidth) + Math.abs(height - originalHeight) < 2) return; this.checkpoint(); this.layout.blocks[id] = { ...this.layout.blocks[id], x: this.layout.blocks[id]?.x ?? parseFloat(card.style.left), y: this.layout.blocks[id]?.y ?? parseFloat(card.style.top), width, height }; this.emit(); this.render(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', cancel);
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
