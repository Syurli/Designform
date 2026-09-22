import { parseDocument, stringify } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';
import { readHeader } from './markdown.ts';

/** 元数据局部修改尽量保留 YAML 注释和字段顺序，正文不重新序列化。 */
export function setMetadata(text: string, values: Record<string, unknown>) {
  const header = readHeader(text), match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const yaml = parseDocument(match?.[1] ?? '');
  for (const [key, value] of Object.entries(values)) if (value === undefined || value === '') yaml.delete(key); else yaml.set(key, value);
  return `---\n${yaml.toString()}---\n${header.body}`;
}
/** 只替换首个实际一级标题；代码块中的示例标题不参与编辑。 */
export function setTitle(text: string, title: string) {
  const { body, bodyOffset } = readHeader(text), ast = fromMarkdown(body);
  const heading = ast.children.find(node => node.type === 'heading' && node.depth === 1);
  if (!heading?.position) return `${text.slice(0, bodyOffset)}\n# ${title}\n\n${body}`;
  return text.slice(0, bodyOffset + heading.position.start.offset!) + `# ${title.replace(/[\r\n]+/g, ' ')}` + text.slice(bodyOffset + heading.position.end.offset!);
}
const plain = (node: Nodes): string => 'value' in node ? String(node.value) : 'children' in node ? node.children.map(child => plain(child)).join('') : '';
const astOf = (body: string) => fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

/** 二级章节排序保留原片段和相邻锚点，不重新排版正文。 */
export function documentSections(text: string) {
  const { body, bodyOffset } = readHeader(text), nodes = astOf(body).children;
  const headings = nodes.flatMap((node, index) => {
    if (node.type !== 'heading' || node.depth !== 2) return [];
    const previous = nodes[index - 1], anchored = previous && /^\s*<a\s+id=["'][A-Za-z0-9_-]+["']\s*>\s*<\/a>\s*$/.test(plain(previous));
    return [{ title: plain(node), start: bodyOffset + (anchored ? previous : node).position!.start.offset! }];
  });
  return headings.map((heading, index) => ({ ...heading, end: headings[index + 1]?.start ?? text.length }));
}
export function moveSection(text: string, index: number, direction: number) {
  const sections = documentSections(text), a = Math.min(index, index + direction), b = Math.max(index, index + direction);
  if (!sections[a] || !sections[b] || b - a !== 1) return text;
  return text.slice(0, sections[a].start) + text.slice(sections[b].start, sections[b].end).trimEnd() + '\n\n' + text.slice(sections[a].start, sections[a].end).trimEnd() + '\n\n' + text.slice(sections[b].end);
}

/** 删除匹配身份的关系表行，不搜索正文中的同名词或破坏用户其他表格。 */
export function removeRelation(text: string, id: string) {
  const { body, bodyOffset } = readHeader(text);
  for (const table of astOf(body).children) {
    if (table.type !== 'table') continue;
    const index = table.children[0].children.findIndex(cell => plain(cell).trim() === '关系 ID');
    if (index < 0) continue;
    const row = table.children.slice(1).find(row => plain(row.children[index]).trim() === id);
    if (!row?.position) continue;
    let end = bodyOffset + row.position.end.offset!; if (text[end] === '\r') end++; if (text[end] === '\n') end++;
    return text.slice(0, bodyOffset + row.position.start.offset!) + text.slice(end);
  }
  return text;
}

/** 功能关系放在文末，显式保留来源身份；正文不再穿插关系清单。 */
export function putRelation(text: string, anchor: string | undefined, relation: { id: string; type: string; target: string; note: string }) {
  text = removeRelation(text, relation.id);
  const { body, bodyOffset } = readHeader(text), ast = astOf(body);
  const anchors = ast.children.map(node => ({ node, match: /^\s*<a\s+id=["']([A-Za-z0-9_-]+)["']\s*>\s*<\/a>\s*$/.exec(plain(node)) })).filter(item => item.match);
  const position = anchor ? anchors.findIndex(item => item.match![1] === anchor) : -1;
  if (anchor && position < 0) throw new Error('找不到规则锚点，请重新读取文档。');
  const at = text.length;
  const source = String(readHeader(text).metadata.id) + (anchor ? `/${anchor}` : '');
  const cell = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const row = `\n\n### 关联索引\n\n| 关系 ID | 来源身份 | 类型 | 目标身份 | 依据 |\n|---|---|---|---|---|\n| ${cell(relation.id)} | ${cell(source)} | ${cell(relation.type)} | ${cell(relation.target)} | ${cell(relation.note)} |\n\n`;
  return text.slice(0, at) + row + text.slice(at);
}

/** 问题模板可直接交给其他模型，不依赖私有表单结构。 */
export function questionDocument(input: { id: string; title: string; background: string; options: string[]; targets: string[]; revision: string | null; round?: string; mode?: 'single' | 'multiple'; follows?: string; condition?: string; when?: { questionId: string; option?: string } }) {
  return `---\n${stringify({ id: input.id, type: 'question', status: 'open', round: input.round ?? 'ROUND-001', baseRevision: input.revision, targets: input.targets, mode: input.mode ?? 'single', ...(input.when ? { when: input.when } : {}), ...(input.follows ? { follows: input.follows, condition: input.condition ?? '继续讨论' } : {}) })}---\n\n# ${input.title.replace(/[\r\n]+/g, ' ')}\n\n## 问题背景\n\n${input.background}\n\n## 可选方案\n\n${input.options.map((option, index) => `- ${String.fromCharCode(65 + index)}：${option.replace(/[\r\n]+/g, ' ')}`).join('\n')}\n- 自定义 / 暂缓 / 问题前提不成立。\n\n## 用户原始回答\n\n尚未回答。\n\n## 模型解释\n\n尚未形成。\n\n## 决定记录\n\n尚未采纳。\n\n## 文档落实\n\n${input.targets.map(target => `- ${target}：待讨论。`).join('\n') || '待讨论。'}\n`;
}
