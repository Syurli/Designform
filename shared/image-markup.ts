/** 正文只接受明确的图片 HTML 子集；像素宽度能被通用 Markdown 阅读器直接理解。 */
export interface SizedImage { src: string; alt: string; title: string; width: number }

const decode = (value: string) => value.replace(/&(?:amp|quot|lt|gt|#39);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'" }[entity]!));
const encode = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** 失败时返回 null，调用方继续按普通 HTML 的安全规则处理。 */
export function parseSizedImage(value: string): SizedImage | null {
  const match = /^\s*<img\s+([^<>]*?)\s*\/?>\s*$/i.exec(value);
  if (!match) return null;
  const attrs = new Map<string, string>(); let rest = match[1].trim();
  while (rest) {
    const attr = /^([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/i.exec(rest);
    if (!attr || attrs.has(attr[1].toLowerCase())) return null;
    attrs.set(attr[1].toLowerCase(), decode(attr[2] ?? attr[3] ?? ''));
    rest = rest.slice(attr[0].length);
  }
  if ([...attrs.keys()].some(name => !['src', 'alt', 'title', 'width'].includes(name))) return null;
  const src = attrs.get('src') ?? '', width = attrs.get('width') ?? '';
  if (!src || !/^[1-9]\d{0,4}$/.test(width) || Number(width)>10000 || /[\u0000-\u001f]/.test(src) || /^(?:javascript|data|file|vbscript):/i.test(src.trim())) return null;
  return { src, alt: attrs.get('alt') ?? '', title: attrs.get('title') ?? '', width: Number(width) };
}

/** 只由结构化字段生成 HTML，绝不拼接未经转义的属性值。 */
export function sizedImageMarkup(image: SizedImage): string {
  const width = Math.max(1, Math.min(10000, Math.round(image.width)));
  return `<img src="${encode(image.src)}" alt="${encode(image.alt)}"${image.title ? ` title="${encode(image.title)}"` : ''} width="${width}">`;
}
