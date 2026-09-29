import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { readHeader } from './markdown.ts';

/** 一个块对应 Markdown 顶层 AST 节点；source 不含身份注释，便于交给正文编辑器。 */
export interface DocumentBlock {
  id: string;
  source: string;
  type: string;
  depth?: number;
  /** 块与身份注释的起点、正文结束点，均为完整 Markdown 中的字符偏移。 */
  start: number;
  end: number;
  sourceStart: number;
  section?: string;
  /** null 表示文档直属；undefined 表示旧文档按标题级别推断。 */
  explicitParent?: string | null;
}

const marker = /^<!-- cewen:block ([A-Za-z0-9][A-Za-z0-9_-]{0,119})(?: parent=(root|[A-Za-z0-9][A-Za-z0-9_-]{0,119}))? -->$/;
const newId = () => `block-${crypto.randomUUID()}`;
/** 引用定义和独立锚点是结构元信息，不是可排版正文块。 */
const metadataBlock = (block: DocumentBlock) => block.type === 'definition' || block.type === 'html' && /^<a\s+id=["'][A-Za-z0-9_-]+["']\s*>\s*<\/a>\s*$/i.test(block.source.trim());

/** 仅移除严格匹配的独立身份行，普通 HTML 注释和正文原样保留。 */
export function stripBlockIds(markdown: string): string {
  const header = readHeader(markdown);
  const root = fromMarkdown(header.body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  let result = markdown;
  for (const node of [...root.children].reverse()) {
    if (node.type !== 'html' || !marker.test(node.value.trim()) || node.position?.start.offset === undefined || node.position.end.offset === undefined) continue;
    const start = header.bodyOffset + node.position.start.offset;
    let end = header.bodyOffset + node.position.end.offset;
    if (markdown.slice(end, end + 2) === '\r\n') end += 2;
    else if (markdown[end] === '\n') end++;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** 标记通过顶层 AST 位置绑定；标题、列表、表格和设计块都保持原始 Markdown。 */
export function parseDocumentBlocks(markdown: string): DocumentBlock[] {
  const header = readHeader(markdown);
  const root = fromMarkdown(header.body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const blocks: DocumentBlock[] = [];
  let pending: { id: string; start: number; end: number; parent?: string | null } | undefined;
  const sections: { id: string; depth: number }[] = [];
  for (const node of root.children) {
    const start = header.bodyOffset + (node.position?.start.offset ?? 0);
    const end = header.bodyOffset + (node.position?.end.offset ?? 0);
    const identity = node.type === 'html' ? marker.exec(node.value.trim()) : null;
    if (identity) { pending = { id: identity[1], start, end, parent: identity[2] === 'root' ? null : identity[2] }; continue; }
    if (pending && markdown.slice(pending.end, start).trim()) pending = undefined;
    const block: DocumentBlock = { id: pending?.id ?? '', source: markdown.slice(start, end), type: node.type, start: pending?.start ?? start, end, sourceStart: start, ...(node.type === 'heading' ? { depth: node.depth } : {}) };
    if (node.type === 'heading') {
      while (sections.length && sections.at(-1)!.depth >= node.depth) sections.pop();
      block.section = sections.at(-1)?.id;
      sections.push({ id: block.id, depth: node.depth });
    } else block.section = sections.at(-1)?.id;
    if (pending?.parent !== undefined) { block.explicitParent = pending.parent; block.section = pending.parent ?? undefined; }
    blocks.push(block);
    pending = undefined;
  }
  // 外部 Markdown 的悬空／循环父级不参与视图遍历，防止布局递归或折叠卡死。
  const byId = new Map(blocks.filter(b => b.id).map(b => [b.id, b]));
  for (const block of blocks) {
    const seen = new Set([block.id]); let parent = block.section;
    while (parent) { const item = byId.get(parent); if (seen.has(parent) || item?.type !== 'heading') { block.section = undefined; break; } seen.add(parent); parent = item.section; }
  }
  return blocks;
}

/** 画布首次启用时补标记；已有有效 ID 原样保留，重复 ID 会重新分配。 */
export function ensureBlockIds(markdown: string): string {
  const blocks = parseDocumentBlocks(markdown), seen = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const block of blocks) {
    if (metadataBlock(block)) continue;
    if (block.id && !seen.has(block.id)) { seen.add(block.id); continue; }
    const id = newId(); seen.add(id);
    if (block.start < block.sourceStart) edits.push({ start: block.start, end: block.sourceStart, text: `<!-- cewen:block ${id}${block.explicitParent !== undefined ? ` parent=${block.explicitParent ?? 'root'}` : ''} -->\n` });
    else edits.push({ start: block.start, end: block.start, text: `<!-- cewen:block ${id} -->\n` });
  }
  let result = markdown;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** 富文本模式隐藏身份标记后，先按原文匹配，再有限范围继承被改块的 ID。 */
export function transferBlockIds(original: string, next: string): string {
  const previous = parseDocumentBlocks(ensureBlockIds(original));
  const clean = stripBlockIds(next);
  const incoming = parseDocumentBlocks(clean);
  const used = new Set<string>(), matches = new Map<number, string>();
  const normalized = (source: string) => source.replace(/\s+/g, ' ').trim();
  const assign = (index: number, oldIndex: number) => { const id = previous[oldIndex].id; matches.set(index, id); used.add(id); };
  for (let index = 0; index < incoming.length; index++) {
    if (metadataBlock(incoming[index])) continue;
    const exact = previous.findIndex(block => block.id && !used.has(block.id) && block.type === incoming[index].type && block.source === incoming[index].source);
    if (exact >= 0) assign(index, exact);
  }
  for (let index = 0; index < incoming.length; index++) {
    if (matches.has(index)) continue;
    if (metadataBlock(incoming[index])) continue;
    const similar = previous.findIndex(block => block.id && !used.has(block.id) && block.type === incoming[index].type && normalized(block.source) === normalized(incoming[index].source));
    if (similar >= 0) assign(index, similar);
  }
  for (let index = 0; index < incoming.length; index++) {
    if (matches.has(index)) continue;
    if (metadataBlock(incoming[index])) continue;
    const nearby = previous.map((block, oldIndex) => ({ block, oldIndex })).filter(item => item.block.id && !used.has(item.block.id) && item.block.type === incoming[index].type && Math.abs(item.oldIndex - index) <= 2).sort((a, b) => Math.abs(a.oldIndex - index) - Math.abs(b.oldIndex - index))[0];
    if (nearby) assign(index, nearby.oldIndex);
  }
  let result = clean;
  for (let index = incoming.length - 1; index >= 0; index--) {
    if (metadataBlock(incoming[index])) continue;
    const id = matches.get(index) ?? newId();
    const old = previous.find(b => b.id === id);
    result = result.slice(0, incoming[index].start) + `<!-- cewen:block ${id}${old?.explicitParent !== undefined ? ` parent=${old.explicitParent ?? 'root'}` : ''} -->\n` + result.slice(incoming[index].start);
  }
  return result;
}

/** 显式结构编辑后记录全部归属；普通排序不会让 Markdown 标题重新吸收直属段落。 */
export function serializeDocumentBlocks(markdown: string, blocks: DocumentBlock[]): string {
  return markdown.slice(0, readHeader(markdown).bodyOffset) + blocks.map(b =>
    `${b.id ? `<!-- cewen:block ${b.id} parent=${b.section ?? 'root'} -->\n` : ''}${b.source.trimEnd()}`
  ).join('\n\n') + '\n';
}

/** 章节子树按身份遍历，不以相邻坐标或相邻段落猜测后代。 */
export function blockSubtree(blocks: DocumentBlock[], id: string): Set<string> {
  const ids = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const b of blocks) if (b.section && ids.has(b.section) && !ids.has(b.id)) { ids.add(b.id); grew = true; } }
  return ids;
}

/** 只改变公开阅读顺序；父级不变，章节携带整个子树。 */
export function reorderDocumentBlock(markdown: string, id: string, targetId: string, after = false): string {
  const blocks = parseDocumentBlocks(ensureBlockIds(markdown)), chosen = blocks.find(b => b.id === id);
  if (!chosen || id === targetId) return markdown;
  const ids = blockSubtree(blocks, id); if (ids.has(targetId)) return markdown;
  const moving = blocks.filter(b => ids.has(b.id)), rest = blocks.filter(b => !ids.has(b.id));
  let at = rest.findIndex(b => b.id === targetId); if (at < 0) return markdown;
  if(after&&rest[at].type==='heading'){const targetTree=blockSubtree(rest,targetId);at=Math.max(...rest.map((b,i)=>targetTree.has(b.id)?i:-1));}
  rest.splice(at + Number(after), 0, ...moving);
  return serializeDocumentBlocks(markdown, rest);
}

/** 明确归入／解除操作；归入章节默认追加，解除保持当前阅读位置。 */
export function reparentDocumentBlock(markdown: string, id: string, parent?: string): string {
  const blocks = parseDocumentBlocks(ensureBlockIds(markdown)), chosen = blocks.find(b => b.id === id);
  if (!chosen || chosen.section === parent) return markdown;
  const ids = blockSubtree(blocks, id), target = blocks.find(b => b.id === parent);
  if (parent && (!target || target.type !== 'heading' || ids.has(parent))) throw new Error('不能归入自身、后代或非标题块。');
  if (chosen.type === 'heading' && target) {
    const delta = (target.depth ?? 1) + 1 - (chosen.depth ?? 1);
    for (const b of blocks.filter(b => ids.has(b.id) && b.type === 'heading')) {
      const depth = (b.depth ?? 1) + delta; if (depth > 6 || depth < 1) throw new Error('归入后标题超过 6 级，请先调整章节层级。');
      b.depth = depth; b.source = b.source.replace(/^#{1,6}(?=\s)/, '#'.repeat(depth));
    }
  }
  chosen.section = parent;
  if (!parent) return serializeDocumentBlocks(markdown, blocks);
  const moving = blocks.filter(b => ids.has(b.id)), rest = blocks.filter(b => !ids.has(b.id));
  const targetIds = blockSubtree(rest, parent);
  const at = Math.max(...rest.map((b,i) => targetIds.has(b.id) ? i : -1));
  rest.splice(at + 1, 0, ...moving);
  return serializeDocumentBlocks(markdown, rest);
}
