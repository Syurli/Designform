import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { parseDocumentBlocks } from '../shared/document-blocks';
import { writingParts } from '../shared/authoring';
import { parseInkCompanion, parseLayoutCompanion, inkCompanionPath, layoutCompanionPath } from '../shared/document-companion';
import type { InkCompanion, LayoutCompanion } from '../shared/document-companion';
import { countDocumentContent } from '../shared/content-statistics';
import { projectMarkdown } from './document-reading';
import { projectAssetUrl } from './project-client';
import { mountDesignBlocks } from './rich-document-plugins';
import { AnnotationLayer } from './annotation-layer';
import { DocumentCanvas } from './document-canvas';
import './document-presentation.css';

/** 读取受控公开伴随文件；格式不完整时正文仍可正常阅读。 */
function companion<T>(snapshot: ProjectSnapshot, path: string, parse: (text: string, path: string) => T): T | undefined {
  const entry = snapshot.companions?.[path]; if (!entry) return undefined;
  try { return parse(entry.text, path); } catch { return undefined; }
}

interface PresentationOptions { onEdit?: () => void }

/** 关联索引是正文尾部技术依据，不参与自由排版卡片。 */
function splitTechnicalTail(body: string): { content: string; tail: string } {
  const blocks = parseDocumentBlocks(body);
  const at = blocks.findIndex(block => block.type === 'heading' && block.depth === 3 && /^###\s*关联索引\s*$/.test(block.source.trim()));
  if (at < 0 || blocks.slice(at + 1).some(block => block.type !== 'table' && !(block.type === 'heading' && /^###\s*关联索引\s*$/.test(block.source.trim())))) return { content: body, tail: '' };
  return { content: body.slice(0, blocks[at].start), tail: body.slice(blocks[at].start) };
}

/** 为单个文档挂载完整阅读页；所有控件只影响本次阅读界面。 */
export function mountDocumentPresentation(host: HTMLElement, doc: ProjectDocument, snapshot: ProjectSnapshot, options: PresentationOptions = {}): () => void {
  const root = document.createElement('article'); root.className = 'cewen-document-presentation'; root.setAttribute('aria-label', `阅读文档：${doc.title}`); host.append(root);
  const header = document.createElement('header'); header.className = 'cewen-document-presentation-header';
  const identity = document.createElement('div'); const eyebrow = document.createElement('small'); eyebrow.textContent = doc.type === 'gdd' ? '游戏总纲' : doc.type === 'dd' ? '设计文档' : '项目文档'; const title = document.createElement('h1'); title.textContent = doc.title; identity.append(eyebrow, title); header.append(identity);
  if (options.onEdit && !snapshot.historical) { const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑文档'; edit.setAttribute('aria-label', `编辑文档：${doc.title}`); edit.addEventListener('click', options.onEdit); header.append(edit); }
  root.append(header);
  const paper = document.createElement('div'); paper.className = 'cewen-document-paper'; root.append(paper);
  const ink = companion(snapshot, inkCompanionPath(doc.id), parseInkCompanion) ?? { format: 1, documentId: doc.id, items: [] } satisfies InkCompanion;
  const layout = companion(snapshot, layoutCompanionPath(doc.id), parseLayoutCompanion);
  const body = writingParts(doc.text).body;
  const separated = splitTechnicalTail(body);
  const blocks = parseDocumentBlocks(separated.content);
  const hasMarkers = blocks.length > 0 && blocks.every(block => Boolean(block.id));
  const disposers: (() => void)[] = [];
  if (layout && Object.keys(layout.blocks).length && hasMarkers) mountLayout(paper, doc, separated.content, body, snapshot, layout, options, disposers);
  else mountLinear(paper, doc, body, snapshot, options, disposers);
  // 笔画层使用稳定块 ID 定位；阅读模式没有绘画、拖动或保存回调。
  const annotation = new AnnotationLayer(paper, null, { shared: ink, personal: [], readonly: true, onChange: () => {}, resolveImage: path => projectAssetUrl(snapshot, path) });
  if(ink.items.length){const toggle=document.createElement('button');toggle.type='button';toggle.textContent='隐藏注释';toggle.setAttribute('aria-pressed','true');toggle.addEventListener('click',()=>{const hidden=paper.classList.toggle('hide-ink');toggle.textContent=hidden?'显示注释':'隐藏注释';toggle.setAttribute('aria-pressed',String(!hidden));});header.append(toggle);}
  const stats = countDocumentContent(doc.text, { ink });
  const footer = document.createElement('footer'); footer.className = 'cewen-document-presentation-footer';
  footer.textContent = `正文 ${stats.characters.toLocaleString()} 字符 · 图片 ${stats.imageReferences} · 对白 ${stats.dialogueNodes} 节点 · 色板 ${stats.palettes} · 注释 ${stats.annotations}`;
  root.append(footer);
  return () => { annotation.dispose(); disposers.forEach(dispose => dispose()); root.remove(); };
}

/** 没有公开排版时保持 Markdown 阅读顺序，并让每个源块提供可定位锚点。 */
function mountLinear(paper: HTMLElement, doc: ProjectDocument, body: string, snapshot: ProjectSnapshot, options: PresentationOptions, disposers: (() => void)[]) {
  const blocks = parseDocumentBlocks(body);
  const definitions = blocks.filter(block => block.type === 'definition').map(block => block.source).join('\n\n');
  const complete = document.createElement('div'); complete.innerHTML = projectMarkdown({ ...doc, text: body }, snapshot);
  const technical = complete.querySelector<HTMLElement>('.document-technical'); technical?.remove();
  const technicalBlocks = new Set<number>();
  blocks.forEach((block, index) => {
    if (block.type !== 'table' || !/关系 ID/.test(block.source.split(/\r?\n/)[0] ?? '') || !/目标身份/.test(block.source.split(/\r?\n/)[0] ?? '')) return;
    technicalBlocks.add(index);
    if (index > 0 && blocks[index - 1].type === 'heading' && /^#{1,6}\s*(?:关联设计|设计关系|关系索引|关联索引)\s*$/.test(blocks[index - 1].source.trim())) technicalBlocks.add(index - 1);
  });
  const outline = document.createElement('nav'); outline.className = 'cewen-document-outline'; outline.setAttribute('aria-label', '文档标题目录');
  const content = document.createElement('div'); content.className = 'cewen-document-linear markdown-preview'; paper.append(outline, content);
  const sections: { level: number; wrapper: HTMLElement; button: HTMLButtonElement; collapsed: boolean }[] = [];
  const rows: { wrapper: HTMLElement; level?: number; heading?: typeof sections[number] }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'definition' || technicalBlocks.has(index)) continue;
    const html = projectMarkdown({ ...doc, text: block.source + (definitions ? `\n\n${definitions}` : '') }, snapshot);
    if (!html.trim()) continue;
    const wrapper = document.createElement('div'); wrapper.className = 'cewen-document-source-block'; if (block.id) wrapper.dataset.blockId = block.id;
    wrapper.innerHTML = html; content.append(wrapper); disposers.push(mountDesignBlocks(wrapper, { onEdit: options.onEdit ? () => options.onEdit!() : undefined }));
    if (block.type !== 'heading') { rows.push({ wrapper }); continue; }
    const heading = wrapper.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6');
    if (!heading) { rows.push({ wrapper }); continue; }
    const level = block.depth ?? Number(heading.tagName.slice(1));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'cewen-document-collapse'; toggle.textContent = '▾'; toggle.setAttribute('aria-label', `折叠标题：${heading.textContent || '未命名标题'}`); toggle.setAttribute('aria-expanded', 'true');
    heading.prepend(toggle); const item = { level, wrapper, button: toggle, collapsed: false }; sections.push(item); rows.push({ wrapper, level, heading: item });
    const link = document.createElement('button'); link.type = 'button'; link.className = 'cewen-document-outline-item'; link.style.paddingLeft = `${8 + Math.max(0, level - 1) * 13}px`; link.textContent = heading.textContent?.replace(/^▾/, '') || '未命名标题'; link.addEventListener('click', () => { item.collapsed = false; const at = rows.findIndex(row => row.wrapper === wrapper); let ancestorThreshold = level; for (let prior = at - 1; prior >= 0; prior--) { const ancestor = rows[prior].heading; if (!ancestor) continue; if (ancestor.level < ancestorThreshold) { ancestor.collapsed = false; ancestorThreshold = ancestor.level; } } refresh(); wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' }); }); outline.append(link);
    toggle.addEventListener('click', event => { event.preventDefault(); item.collapsed = !item.collapsed; refresh(); });
  }
  if (technical) { content.append(technical); disposers.push(mountDesignBlocks(technical)); }
  if (!sections.length) outline.remove();
  const refresh = () => {
    const active: number[] = [];
    for (const row of rows) {
      if (row.heading) { while (active.length && active.at(-1)! >= row.heading.level) active.pop(); row.wrapper.hidden = active.length > 0; row.heading.button.textContent = row.heading.collapsed ? '▸' : '▾'; row.heading.button.setAttribute('aria-expanded', String(!row.heading.collapsed)); if (row.heading.collapsed) active.push(row.heading.level); }
      else row.wrapper.hidden = active.length > 0;
    }
  };
  refresh();
}

/** 公开画布显示保存在伴随文件中的实际位置；由 DocumentCanvas 负责布局投影。 */
function mountLayout(paper: HTMLElement, doc: ProjectDocument, contentBody: string, fullBody: string, snapshot: ProjectSnapshot, layout: LayoutCompanion, options: PresentationOptions, disposers: (() => void)[]) {
  const definitions = parseDocumentBlocks(contentBody).filter(block => block.type === 'definition').map(block => block.source).join('\n\n');
  let previews: (() => void)[] = [];
  const canvas = new DocumentCanvas(paper, {
    markdown: contentBody, layout, readOnly: true, onChange: () => {},
    render: source => projectMarkdown({ ...doc, text: source + (definitions ? `\n\n${definitions}` : '') }, snapshot),
    onRender: stage => {
      previews.forEach(dispose => dispose()); previews = [];
      stage.querySelectorAll<HTMLElement>('.document-canvas-content').forEach(content => previews.push(mountDesignBlocks(content, { onEdit: options.onEdit ? () => options.onEdit!() : undefined })));
    },
  });
  disposers.push(() => { previews.forEach(dispose => dispose()); canvas.dispose(); });
  if (fullBody !== contentBody) { const full = document.createElement('div'); full.innerHTML = projectMarkdown({ ...doc, text: fullBody }, snapshot); const technical = full.querySelector<HTMLElement>('.document-technical'); if (technical) paper.append(technical); }
}
