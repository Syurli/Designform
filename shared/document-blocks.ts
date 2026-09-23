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
}

const marker = /^<!-- cewen:block ([A-Za-z0-9][A-Za-z0-9_-]{0,119}) -->$/;
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
  let pending: { id: string; start: number; end: number } | undefined;
  const sections: { id: string; depth: number }[] = [];
  for (const node of root.children) {
    const start = header.bodyOffset + (node.position?.start.offset ?? 0);
    const end = header.bodyOffset + (node.position?.end.offset ?? 0);
    const identity = node.type === 'html' ? marker.exec(node.value.trim()) : null;
    if (identity) { pending = { id: identity[1], start, end }; continue; }
    if (pending && markdown.slice(pending.end, start).trim()) pending = undefined;
    const block: DocumentBlock = { id: pending?.id ?? '', source: markdown.slice(start, end), type: node.type, start: pending?.start ?? start, end, sourceStart: start, ...(node.type === 'heading' ? { depth: node.depth } : {}) };
    if (node.type === 'heading') {
      while (sections.length && sections.at(-1)!.depth >= node.depth) sections.pop();
      block.section = sections.at(-1)?.id;
      sections.push({ id: block.id, depth: node.depth });
    } else block.section = sections.at(-1)?.id;
    blocks.push(block);
    pending = undefined;
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
    if (block.start < block.sourceStart) edits.push({ start: block.start, end: block.sourceStart, text: `<!-- cewen:block ${id} -->\n` });
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
    result = result.slice(0, incoming[index].start) + `<!-- cewen:block ${id} -->\n` + result.slice(incoming[index].start);
  }
  return result;
}
