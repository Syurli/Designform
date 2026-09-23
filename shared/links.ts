import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';
import { readHeader } from './markdown.ts';
import type { Diagnostic } from './model.ts';
import { parseSizedImage, sizedImageMarkup } from './image-markup.ts';

/** 项目相对路径计算在浏览器和服务共用，不允许越过项目根。 */
export function linkTarget(file: string, url: string) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(url)) return null;
  const [name, fragment] = url.split('#', 2); let decoded: string;
  try { decoded = decodeURIComponent(name); } catch { return null; }
  const parts = (decoded ? file.split('/').slice(0, -1) : []).concat((decoded || file).split('/')), result: string[] = [];
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') { if (!result.length) return null; result.pop(); } else result.push(part); }
  return { path: result.join('/'), fragment: fragment ?? '' };
}
export function relativeLink(from: string, to: string) {
  const a = from.split('/').slice(0,-1), b = to.split('/');
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return encodeURI([...a.map(() => '..'), ...b].join('/'));
}
/** 只替换 Markdown AST 确认的链接地址，代码示例与普通正文保持原样。 */
export function rewriteLinks(text: string, source: string, destination: string, mapping: Map<string, string>) {
  const { body, bodyOffset } = readHeader(text), changes: { start: number; end: number; value: string }[] = [];
  function visit(node: Nodes) {
    // 缩放图片的标准 HTML 与普通 Markdown 图片一起迁移，不能在移动文档后遗留旧路径。
    if(node.type==='html'&&node.position){
      const image=parseSizedImage(node.value),target=image&&linkTarget(source,image.src),mapped=target&&mapping.get(target.path);
      if(image&&target&&mapped)changes.push({start:bodyOffset+node.position.start.offset!,end:bodyOffset+node.position.end.offset!,value:sizedImageMarkup({...image,src:relativeLink(destination,mapped)+(target.fragment?`#${target.fragment}`:'')})});
    }
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.position) {
      const target = linkTarget(source, node.url), mapped = target && mapping.get(target.path);
      if (target && mapped) {
        const start = bodyOffset + node.position.start.offset!, end = bodyOffset + node.position.end.offset!, raw = text.slice(start, end);
        const at = raw.indexOf(node.url, node.type === 'definition' ? raw.indexOf(']:') + 2 : raw.indexOf('](') + 2);
        if (at >= 0) changes.push({ start: start + at, end: start + at + node.url.length, value: (mapped === destination && target.fragment ? '' : relativeLink(destination, mapped)) + (target.fragment ? `#${target.fragment}` : '') });
      }
    }
    if ('children' in node) node.children.forEach(child => visit(child));
  }
  visit(fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  for (const change of changes.sort((a,b) => b.start - a.start)) text = text.slice(0, change.start) + change.value + text.slice(change.end);
  return text;
}

/** 普通相对链接的断链作为可读诊断；未能验证的外部网页不冒充已校验。 */
export function diagnoseLinks(files: Map<string, string | null>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [file, text] of files) {
    if (text === null || !file.endsWith('.md')) continue;
    const { body } = readHeader(text);
    function visit(node: Nodes) {
      if(node.type==='html'){
        const image=parseSizedImage(node.value),target=image&&linkTarget(file,image.src);
        if(image&&target&&!files.has(target.path))diagnostics.push({path:file,severity:'warning',code:'BROKEN_MARKDOWN_LINK',message:`相对图片目标不存在：${image.src}`,line:node.position?.start.line});
      }
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        const target = linkTarget(file, node.url);
        if (target && !files.has(target.path)) diagnostics.push({ path: file, severity: 'warning', code: 'BROKEN_MARKDOWN_LINK', message: `相对链接目标不存在：${node.url}`, line: node.position?.start.line });
      }
      if ('children' in node) node.children.forEach(child => visit(child));
    }
    visit(fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  }
  return diagnostics;
}
