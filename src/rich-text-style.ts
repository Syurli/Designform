import { $markSchema } from '@milkdown/kit/utils';
import type { Handle } from 'mdast-util-to-markdown';
import { foldTextStyles, normalizeTextStyle, parseTextStyleTag, textStyleCss, textStyleOpenTag, type TextStyleNode } from '../shared/text-style';
import type { Root } from 'mdast';

/** 行内样式是独立 mark，不占用粗体、斜体、链接等已有格式。 */
export const textStyleSchema = $markSchema('cewen_text_style', () => ({
  // 样式包在 Markdown 斜体/粗体之外，避免句中 *<span> 被当作普通星号。
  priority: 10,
  attrs: { fontFamily: { default: null }, color: { default: null }, background: { default: null }, highlight: { default: null } },
  parseDOM: [{ tag: 'span[data-cewen-text-style="1"]', getAttrs: dom => parseTextStyleTag(dom.outerHTML.slice(0, dom.outerHTML.indexOf('>') + 1)) ?? false }],
  toDOM: mark => {
    const style = normalizeTextStyle(mark.attrs);
    return ['span', { 'data-cewen-text-style': '1', 'data-cewen-fontfamily': style.fontFamily ?? '', 'data-cewen-color': style.color ?? '', 'data-cewen-background': style.background ?? '', 'data-cewen-highlight': style.highlight ?? '', style: textStyleCss(style) }, 0];
  },
  parseMarkdown: { match: node => node.type === 'cewenTextStyle', runner: (state, node, type) => { state.openMark(type, normalizeTextStyle(node.style as TextStyleNode['style'])); state.next(node.children); state.closeMark(type); } },
  toMarkdown: { match: mark => mark.type.name === 'cewen_text_style', runner: (state, mark) => { state.withMark(mark, 'cewenTextStyle', undefined, { style: { ...normalizeTextStyle(mark.attrs) } }); } },
}));

/** 公开 Markdown 中保留可读 span，读取时仅恢复本软件允许的字体/颜色字段。 */
export const textStyleRemarkPlugin = () => (root: Root) => { foldTextStyles(root); };
export const textStyleMarkdownHandler: Handle = (node, _parent, state, info) => {
  const styled = node as TextStyleNode, tracker = state.createTracker(info), opening = tracker.move(textStyleOpenTag(styled.style));
  const content = tracker.move(state.containerPhrasing(styled, { ...tracker.current(), before: '>', after: '<' }));
  return opening + content + tracker.move('</span>');
};
