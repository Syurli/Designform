import type { Parent, PhrasingContent, Root } from 'mdast';

/** 公开正文仅保存字体名及颜色；不包含字体文件，也不接受任意 CSS。 */
export interface TextStyle {
  fontFamily: string | null;
  color: string | null;
  background: string | null;
  highlight: string | null;
}
export interface TextStyleNode extends Parent {
  type: 'cewenTextStyle';
  style: TextStyle;
  children: PhrasingContent[];
}
// mdast 同时从根内容表构建 Nodes 联合；两处登记后，共享遍历器才认识行内样式。
declare module 'mdast' {
  interface PhrasingContentMap { cewenTextStyle: TextStyleNode }
  interface RootContentMap { cewenTextStyle: TextStyleNode }
}
export const emptyTextStyle = (): TextStyle => ({ fontFamily: null, color: null, background: null, highlight: null });
/** 字体家族名不成为 CSS 语句；颜色统一为六位十六进制，方便无损往返。 */
export function normalizeTextStyle(value: Partial<TextStyle>): TextStyle {
  const color = (input: unknown): string | null => {
    if (typeof input !== 'string' || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(input)) return null;
    const hex = input.slice(1).toLowerCase(); return '#' + (hex.length === 3 ? [...hex].map(c => c + c).join('') : hex);
  };
  const name = typeof value.fontFamily === 'string' ? value.fontFamily.trim() : '';
  return { fontFamily: name && name.length <= 160 && !/[\u0000-\u001f<>;{}\\]/.test(name) ? name : null, color: color(value.color), background: color(value.background), highlight: color(value.highlight) };
}
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const decodeAttribute = (value: string) => value.replace(/&(?:amp|quot|apos|lt|gt|#39);/g, c => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' }[c]!));
export function textStyleCss(value: Partial<TextStyle>): string {
  const style = normalizeTextStyle(value), css: string[] = [];
  if (style.fontFamily) css.push(`font-family:"${style.fontFamily.replaceAll('"', '\\"')}",sans-serif`);
  if (style.color) css.push(`color:${style.color}`);
  if (style.background) css.push(`background-color:${style.background}`);
  // 荧光笔保留上下留白，与整块字体底色可同时使用，不覆盖字色。
  if (style.highlight) css.push(`background-image:linear-gradient(transparent 28%,${style.highlight} 28%,${style.highlight} 90%,transparent 90%)`);
  css.push('box-decoration-break:clone'); return css.join(';');
}
export function textStyleOpenTag(value: Partial<TextStyle>): string {
  const style = normalizeTextStyle(value);
  const attrs = Object.entries(style).filter(([, v]) => v).map(([key, v]) => `data-cewen-${key.toLowerCase()}="${escapeAttribute(v!)}"`).join(' ');
  return `<span data-cewen-text-style="1"${attrs ? ' ' + attrs : ''} style="${escapeAttribute(textStyleCss(style))}">`;
}
/** 只解析本软件的有限样式标记，展示层始终重新生成 CSS，不信任原 style 属性。 */
export function parseTextStyleTag(source: string): TextStyle | null {
  if (!/^<span\s[^>]*>$/i.test(source.trim())) return null;
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) attrs.set(match[1].toLowerCase(), decodeAttribute(match[3]));
  if (attrs.get('data-cewen-text-style') !== '1') return null;
  return normalizeTextStyle({ fontFamily: attrs.get('data-cewen-fontfamily'), color: attrs.get('data-cewen-color'), background: attrs.get('data-cewen-background'), highlight: attrs.get('data-cewen-highlight') });
}
/** 把成对行内 span 折成文本样式节点；保留位置和所有子格式，损坏标签原样留给源码回退。 */
export function foldTextStyles(root: Root): Root {
  const visit = (parent: Parent) => {
    for (const child of parent.children) if ('children' in child) visit(child as Parent);
    const output: Parent['children'] = [], stack: { opening: Parent['children'][number]; style: TextStyle; children: Parent['children'] }[] = [];
    const append = (node: Parent['children'][number]) => (stack.at(-1)?.children ?? output).push(node);
    for (const node of parent.children) {
      const style = node.type === 'html' ? parseTextStyleTag(String(node.value)) : null;
      if (style) { stack.push({ opening: node, style, children: [] }); continue; }
      if (node.type === 'html' && /^\s*<\/span>\s*$/i.test(String(node.value)) && stack.length) {
        const frame = stack.pop()!;
        append({ type: 'cewenTextStyle', style: frame.style, children: frame.children as PhrasingContent[], ...(frame.opening.position && node.position ? { position: { start: frame.opening.position.start, end: node.position.end } } : {}) } as TextStyleNode);
      } else append(node);
    }
    while (stack.length) { const frame = stack.pop()!; (stack.at(-1)?.children ?? output).push(frame.opening, ...frame.children); }
    parent.children = output;
  };
  visit(root); return root;
}
