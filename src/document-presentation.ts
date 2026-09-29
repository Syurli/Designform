import { readHeader } from '../shared/markdown';
import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { parseDocumentBlocks, ensureBlockIds } from '../shared/document-blocks';
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
import { mountCreativeBlocks, mountDocumentQuestions } from './creative/inline';

/** 读取受控公开伴随文件；格式不完整时正文仍可正常阅读。 */
function companion<T>(snapshot: ProjectSnapshot, path: string, parse: (text: string, path: string) => T): T | undefined {
  const entry = snapshot.companions?.[path]; if (!entry) return undefined;
  try { return parse(entry.text, path); } catch { return undefined; }
}

interface PresentationOptions {
  onEdit?: () => void;
  /** 策划案预览强制标准阅读排版；公开画布仅用于明确选择的布局阅读。 */
  linear?:boolean; hideHeader?:boolean; hideQuestions?:boolean; reorder?:boolean;
  onReorder?:(id:string,target:string,after:boolean)=>void;
  onReparent?:(id:string,parent?:string)=>void;
  draftAssets?:{path:string;text:string}[];
}

/** 侧栏章节使用公开锚点定位；先展开实际归属链，再滚动并提示目标标题。 */
export function locatePresentationSection(host:HTMLElement,anchor:string):boolean {
  const marker=host.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
  if(!marker)return false;
  let target=marker.closest<HTMLElement>('.cewen-document-source-block');
  if(!target)return false;
  // 独立 <a> 源块属于下一个标题，避免只定位到没有高度的空锚点。
  if(!target.querySelector('h1,h2,h3,h4,h5,h6')&&/^\s*$/.test(target.textContent??'')){
    const next=target.nextElementSibling;
    if(next instanceof HTMLElement&&next.querySelector('h1,h2,h3,h4,h5,h6'))target=next;
  }
  const byId=new Map(Array.from(host.querySelectorAll<HTMLElement>('[data-block-id]')).map(row=>[row.dataset.blockId!,row]));
  let row:HTMLElement|undefined=target;const seen=new Set<HTMLElement>();
  while(row&&!seen.has(row)){
    seen.add(row);
    row.querySelector<HTMLButtonElement>('.cewen-document-collapse[aria-expanded="false"]')?.click();
    row=byId.get(row.dataset.sectionId??'');
  }
  target.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  target.classList.remove('is-section-target');void target.offsetWidth;target.classList.add('is-section-target');
  target.tabIndex=-1;target.focus({preventScroll:true});return true;
}

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
  if(!options.hideHeader)root.append(header);
  root.classList.toggle('is-reordering',!!options.reorder);
  const paper = document.createElement('div'); paper.className = 'cewen-document-paper'; root.append(paper);
  const ink = companion(snapshot, inkCompanionPath(doc.id), parseInkCompanion) ?? { format: 1, documentId: doc.id, items: [] } satisfies InkCompanion;
  const layout = companion(snapshot, layoutCompanionPath(doc.id), parseLayoutCompanion);
  const body = options.hideHeader ? readHeader(doc.text).body : writingParts(doc.text).body;
  const separated = splitTechnicalTail(body);
  const blocks = parseDocumentBlocks(separated.content);
  const hasMarkers = blocks.length > 0 && blocks.every(block => Boolean(block.id));
  const disposers: (() => void)[] = [];
  if (!options.linear && layout && Object.keys(layout.blocks).length && hasMarkers) mountLayout(paper, doc, separated.content, body, snapshot, layout, options, disposers);
  else mountLinear(paper, doc, body, snapshot, options, disposers);
  disposers.push(mountCreativeBlocks(paper,snapshot));
  if(doc.type!=='question'&&!options.hideQuestions)disposers.push(mountDocumentQuestions(root,header,paper,doc,snapshot));
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
  const blocks = parseDocumentBlocks(ensureBlockIds(body));
  const definitions = blocks.filter(block => block.type === 'definition').map(block => block.source).join('\n\n');
  const complete = document.createElement('div'); complete.innerHTML = projectMarkdown({ ...doc, text: body }, snapshot,options.draftAssets);
  const technical = complete.querySelector<HTMLElement>('.document-technical'); technical?.remove();
  const technicalBlocks = new Set<number>();
  blocks.forEach((block, index) => {
    if (block.type !== 'table' || !/关系 ID/.test(block.source.split(/\r?\n/)[0] ?? '') || !/目标身份/.test(block.source.split(/\r?\n/)[0] ?? '')) return;
    technicalBlocks.add(index);
    if (index > 0 && blocks[index - 1].type === 'heading' && /^#{1,6}\s*(?:关联设计|设计关系|关系索引|关联索引)\s*$/.test(blocks[index - 1].source.trim())) technicalBlocks.add(index - 1);
  });
  const outline = document.createElement('nav'); outline.className = 'cewen-document-outline'; outline.setAttribute('aria-label', '文档标题目录');
  const content = document.createElement('div'); content.className = 'cewen-document-linear markdown-preview'; paper.append(outline, content);
  let dragging='';
  if(options.reorder){
    const unlink=document.createElement('div');unlink.className='preview-unlink';unlink.textContent='拖到此处：移到文档直属内容，保留阅读位置';content.append(unlink);
    unlink.ondragover=e=>{if(dragging){e.preventDefault();unlink.classList.add('is-drop-target');}};unlink.ondragleave=()=>unlink.classList.remove('is-drop-target');unlink.ondrop=e=>{e.preventDefault();options.onReparent?.(dragging);};
  }
  const sections: { level: number; wrapper: HTMLElement; button: HTMLButtonElement; collapsed: boolean }[] = [];
  const rows: { wrapper: HTMLElement; level?: number; heading?: typeof sections[number] }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'definition' || technicalBlocks.has(index)) continue;
    const html = projectMarkdown({ ...doc, text: block.source + (definitions ? `\n\n${definitions}` : '') }, snapshot,options.draftAssets);
    if (!html.trim()) continue;
    const wrapper = document.createElement('div'); wrapper.className = 'cewen-document-source-block'; if (block.id) wrapper.dataset.blockId = block.id;
    wrapper.dataset.sectionId=block.section??'';
    wrapper.innerHTML = html; content.append(wrapper); disposers.push(mountDesignBlocks(wrapper, { onEdit: options.onEdit ? () => options.onEdit!() : undefined }));
    if(options.reorder&&block.id){
      const tools=document.createElement('div');tools.className='preview-order-tools';const grip=document.createElement('button');grip.textContent='⠿';grip.draggable=true;grip.setAttribute('aria-label','拖动调整阅读顺序');grip.title='拖动段落；章节携带全部子块，归属不变';tools.append(grip);
      grip.ondragstart=e=>{dragging=block.id;e.dataTransfer?.setData('application/x-cewen-reading-block',block.id);if(e.dataTransfer)e.dataTransfer.effectAllowed='move';};
      grip.ondragend=()=>{dragging='';content.querySelectorAll('.drop-before,.drop-after,.is-drop-target').forEach(el=>el.classList.remove('drop-before','drop-after','is-drop-target'));};
      for(const [label,delta] of [['↑',-1],['↓',1]] as const){const button=document.createElement('button');button.textContent=label;button.setAttribute('aria-label',delta<0?'阅读顺序前移':'阅读顺序后移');button.onclick=()=>{const other=blocks[index+delta];if(other?.id)options.onReorder?.(block.id,other.id,delta>0);};tools.append(button);}
      if(block.section){const detach=document.createElement('button');detach.textContent='解除关联';detach.onclick=()=>options.onReparent?.(block.id);tools.append(detach);}
      if(block.type==='heading'){const into=document.createElement('span');into.className='preview-parent-target';into.textContent='归入本章节';into.ondragover=e=>{if(dragging){e.preventDefault();e.stopPropagation();into.classList.add('is-drop-target');}};into.ondragleave=()=>into.classList.remove('is-drop-target');into.ondrop=e=>{e.preventDefault();e.stopPropagation();options.onReparent?.(dragging,block.id);};tools.append(into);}
      wrapper.prepend(tools);
      wrapper.ondragover=e=>{if(!dragging)return;e.preventDefault();const after=e.clientY>wrapper.getBoundingClientRect().top+wrapper.clientHeight/2;wrapper.classList.toggle('drop-before',!after);wrapper.classList.toggle('drop-after',after);};
      wrapper.ondragleave=e=>{if(!wrapper.contains(e.relatedTarget as Node))wrapper.classList.remove('drop-before','drop-after');};
      wrapper.ondrop=e=>{if(!dragging)return;e.preventDefault();e.stopPropagation();options.onReorder?.(dragging,block.id,e.clientY>wrapper.getBoundingClientRect().top+wrapper.clientHeight/2);};
    }
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
    const byId=new Map(blocks.map(b=>[b.id,b]));
    const folded=new Set(rows.filter(r=>r.heading?.collapsed).map(r=>r.wrapper.dataset.blockId));
    for (const row of rows) {
      let parent=byId.get(row.wrapper.dataset.blockId??'')?.section,hidden=false;const seen=new Set<string>();while(parent&&!seen.has(parent)){seen.add(parent);if(folded.has(parent))hidden=true;parent=byId.get(parent)?.section;}row.wrapper.hidden=hidden;
      if(row.heading){row.heading.button.textContent=row.heading.collapsed?'▸':'▾';row.heading.button.setAttribute('aria-expanded',String(!row.heading.collapsed));}
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
