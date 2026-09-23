import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';
import { readHeader } from './markdown.ts';
import { parseDesignBlock } from './design-blocks.ts';
import type { InkCompanion } from './document-companion.ts';
import { parseSizedImage } from './image-markup.ts';

/** 统计使用可读内容，字符数不含空白但保留标点；代码和注释各自单列。 */
export interface ContentStatistics {
  characters: number;
  chineseCharacters: number;
  foreignWords: number;
  imageReferences: number;
  uniqueAttachments: number;
  tables: number;
  headings: number;
  links: number;
  codeCharacters: number;
  dialogueBlocks: number;
  dialogueNodes: number;
  dialogueLines: number;
  dialogueChoices: number;
  palettes: number;
  paletteColors: number;
  annotations: number;
  annotationCharacters: number;
}

const nonspace = (text: string) => [...text].filter(character => !/\s/u.test(character)).length;
const han = (text: string) => [...text.matchAll(/\p{Script=Han}/gu)].length;
const words = (text: string) => [...text.matchAll(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]+(?:['’\-][\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]+)*/gu)].length;

/** 只将可见文字计入正文，图片替代文字与链接地址不算正文。 */
export function countDocumentContent(markdown: string, options: { ink?: InkCompanion; annotationMarkdown?: string } = {}): ContentStatistics {
  const result: ContentStatistics = { characters: 0, chineseCharacters: 0, foreignWords: 0, imageReferences: 0, uniqueAttachments: 0, tables: 0, headings: 0, links: 0, codeCharacters: 0, dialogueBlocks: 0, dialogueNodes: 0, dialogueLines: 0, dialogueChoices: 0, palettes: 0, paletteColors: 0, annotations: 0, annotationCharacters: 0 };
  const attachments = new Set<string>();
  const visible = (text: string) => { result.characters += nonspace(text); result.chineseCharacters += han(text); result.foreignWords += words(text); };
  const asset = (url: string) => { if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) attachments.add(url.split(/[?#]/)[0]); };
  const parse = (text: string) => fromMarkdown(readHeader(text).body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const root = parse(markdown);
  const references = new Map(root.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]));
  const plain = (node: Nodes): string => 'value' in node ? String(node.value) : 'children' in node ? node.children.map(plain).join('') : '';
  const relationTable = (node: Nodes) => node.type === 'table' && ['关系 ID', '类型', '目标身份', '依据'].every(name => node.children[0]?.children.some(cell => plain(cell).trim() === name));
  const visit = (node: Nodes): void => {
    switch (node.type) {
      case 'text': visible(node.value); return;
      case 'inlineCode': result.codeCharacters += nonspace(node.value); return;
      case 'code': {
        // 手改中的无效 YAML 仍是可读草稿；统计失败时只放入代码单列。
        let block: ReturnType<typeof parseDesignBlock> = null;
        try { block = node.lang ? parseDesignBlock(node.lang, node.value) : null; } catch { /* 正式解析诊断由文档编辑器负责。 */ }
        if (block?.kind === 'dialogue') {
          result.dialogueBlocks++;
          result.dialogueNodes += block.nodes.length;
          visible(block.title);
          for (const item of block.nodes) {
            if (item.type === 'line') {
              result.dialogueLines++;
              if (item.speaker) visible(item.speaker);
              if (item.text) visible(item.text);
              for (const choice of item.choices ?? []) { result.dialogueChoices++; visible(choice.text); }
            }
            if (item.type === 'end' && item.text) visible(item.text);
          }
        } else if (block?.kind === 'palette') {
          result.palettes++; result.paletteColors += block.colors.length;
          visible(block.title);
          for (const color of block.colors) { if (color.role) visible(color.role); if (color.intent) visible(color.intent); }
        } else result.codeCharacters += nonspace(node.value);
        return;
      }
      case 'html': {
        const image = parseSizedImage(node.value);
        if (image) { result.imageReferences++; asset(image.src); }
        return;
      }
      case 'yaml': case 'definition': return;
      case 'image': result.imageReferences++; asset(node.url); return;
      case 'imageReference': result.imageReferences++; asset(references.get(node.identifier.toLowerCase()) ?? ''); return;
      case 'link': result.links++; break;
      case 'linkReference': result.links++; break;
      case 'table': result.tables++; break;
      case 'heading': result.headings++; break;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const [index, node] of root.children.entries()) {
    if (relationTable(node)) continue;
    if (node.type === 'heading' && /^(关联设计|设计关系|关系索引|关联索引)$/.test(plain(node).trim()) && root.children[index + 1] && relationTable(root.children[index + 1])) continue;
    visit(node);
  }
  if (options.ink) {
    result.annotations += options.ink.items.length;
    result.annotationCharacters += options.ink.items.reduce((sum, item) => sum + nonspace(item.text ?? ''), 0);
    for (const item of options.ink.items) if (item.assetPath) attachments.add(item.assetPath);
  }
  if (options.annotationMarkdown) {
    const text = options.annotationMarkdown;
    result.annotations += 1;
    result.annotationCharacters += nonspace(readHeader(text).body);
  }
  result.uniqueAttachments = attachments.size;
  return result;
}
