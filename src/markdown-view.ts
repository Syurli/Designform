import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';
import { readHeader } from '../shared/markdown.ts';

/** 渲染采用白名单 AST，不执行用户 HTML，链接和图片必须经过受控地址转换。 */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export function markdownView(text: string, resolve: (url: string, image: boolean) => string | null = () => null, terms = new Map<string, string>()): string {
  let body = text; try { body = readHeader(text).body; } catch { /* 格式异常时仍显示可安全阅读的原文。 */ }
  const ast = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map(ast.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]));
  const plain = (node: Nodes): string => 'value' in node ? String(node.value) : 'children' in node ? node.children.map(plain).join('') : '';
  const relationTable = (node: Nodes) => node.type === 'table' && ['关系 ID', '类型', '目标身份', '依据'].every(name => node.children[0]?.children.some(cell => plain(cell).trim() === name));
  // 只后置已识别的功能表和紧邻的专用标题，普通设计表格、状态叙述及其他内容原位保留。
  const technical: { node: Nodes; owner: string }[] = []; let owner = '';
  const readable = ast.children.filter((node, index) => {
    if (node.type === 'heading' && node.depth <= 2) owner = plain(node);
    if (relationTable(node)) { technical.push({ node, owner: node.type === 'table' && node.children[0].children.some(cell => plain(cell).trim() === '来源身份') ? '文档与条目关联' : owner }); return false; }
    return !(node.type === 'heading' && /^(关联设计|设计关系|关系索引|关联索引)$/.test(plain(node).trim()) && ast.children[index + 1] && relationTable(ast.children[index + 1]));
  });
  const pattern = terms.size ? new RegExp([...terms.keys()].sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const linkedText = (value: string) => {
    if (!pattern) return escapeHtml(value);
    let result = '', last = 0; pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const at = match.index!;
      // 英文缩写只匹配完整单词；代码和显式链接内部不会再次套链接。
      if (/^[A-Za-z0-9_]/.test(match[0]) && /[A-Za-z0-9_]/.test(value[at - 1] ?? '')) continue;
      if (/[A-Za-z0-9_]$/.test(match[0]) && /[A-Za-z0-9_]/.test(value[at + match[0].length] ?? '')) continue;
      result += escapeHtml(value.slice(last, at)) + `<a class="document-mention" href="${escapeHtml(terms.get(match[0])!)}">${escapeHtml(match[0])}</a>`; last = at + match[0].length;
    }
    return result + escapeHtml(value.slice(last));
  };
  const render = (node: Nodes, auto = true): string => {
    const nested = auto && !['heading', 'link', 'linkReference', 'table'].includes(node.type);
    const children = 'children' in node ? node.children.map(child => render(child, nested)).join('') : '';
    switch (node.type) {
      case 'root': return children;
      case 'text': return auto ? linkedText(node.value) : escapeHtml(node.value);
      case 'paragraph': return `<p>${children}</p>`;
      case 'heading': return `<h${node.depth}>${children}</h${node.depth}>`;
      case 'strong': return `<strong>${children}</strong>`;
      case 'emphasis': return `<em>${children}</em>`;
      case 'delete': return `<del>${children}</del>`;
      case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
      case 'code': return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
      case 'blockquote': return `<blockquote>${children}</blockquote>`;
      case 'list': return node.ordered ? `<ol start="${node.start ?? 1}">${children}</ol>` : `<ul>${children}</ul>`;
      case 'listItem': return `<li>${node.checked === null || node.checked === undefined ? '' : `<input type="checkbox" disabled ${node.checked ? 'checked' : ''}/>`}${children}</li>`;
      case 'table': return `<div class="table-scroll"><table>${node.children.map((row, index) => `<tr>${row.children.map(cell => `<${index ? 'td' : 'th'}>${cell.children.map(child => render(child, false)).join('')}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`;
      case 'link': case 'linkReference': {
        const raw = node.type === 'link' ? node.url : definitions.get(node.identifier.toLowerCase()) ?? '';
        if (/^https?:\/\//i.test(raw)) return `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener noreferrer">${children}</a>`;
        const href = resolve(raw, false); return href ? `<a href="${escapeHtml(href)}">${children}</a>` : `<span title="链接目标不可用">${children}</span>`;
      }
      case 'image': case 'imageReference': {
        const raw = node.type === 'image' ? node.url : definitions.get(node.identifier.toLowerCase()) ?? '';
        const src = resolve(raw, true); return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt ?? '')}" loading="lazy"/>` : `<span class="quiet">[图片：${escapeHtml(node.alt ?? raw)}]</span>`;
      }
      case 'break': return '<br/>';
      case 'thematicBreak': return '<hr/>';
      case 'html': { const match = /^<a\s+id=["']([A-Za-z0-9_-]+)["']\s*>(?:\s*<\/a>)?(?:\r?\n(#{1,6}) ([^\r\n]+))?\s*$/i.exec(node.value); return match ? `<a id="${match[1]}"></a>${match[2] ? `<h${match[2].length}>${escapeHtml(match[3])}</h${match[2].length}>` : ''}` : ''; }
      default: return children;
    }
  };
  return readable.map(node => render(node)).join('') + (technical.length ? `<details class="document-technical"><summary>关联依据 · ${technical.length} 处</summary><p class="quiet">需要核对设计联系时展开查阅。</p>${technical.map(item => `<section><h4>${escapeHtml(item.owner)}</h4>${render(item.node, false)}</section>`).join('')}</details>` : '');
}

/** 相对链接只在公开 docs 内解析，不允许链接到编辑器工作区。 */
export function resolveDocumentLink(base: string, relative: string): { path: string; anchor: string } | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/|\\/i.test(relative)) return null;
  const url = new URL(relative, `https://project.invalid/${base}`);
  let path: string; try { path = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  return path.startsWith('docs/') ? { path, anchor: url.hash.slice(1) } : null;
}
