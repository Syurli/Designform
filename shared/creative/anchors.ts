import type { ProjectSnapshot } from '../model.ts';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { asData, asString } from './model.ts';
import { buildCreativeIndex, contentHash } from './content.ts';

/** 锚点只保存用户明确选中的摘录；身份优先，文字只用于可证明唯一的重定位。 */
export interface ContentAnchor {
  documentId: string;
  objectId?: string;
  subObjectId?: string;
  blockId?: string;
  excerpt?: string;
  prefix?: string;
  suffix?: string;
  documentHash?: string;
  sourceRevision?: string | null;
  sequenceId?:string;itemId?:string;panelId?:string;shotId?:string;localMs?:number;panelLocalMs?:number;draft?:boolean;
}
export interface ResolvedAnchor {
  state: 'matched' | 'relocated' | 'ambiguous' | 'missing';
  documentId: string;
  objectId?: string;
  blockId?: string;
  start?: number;
  end?: number;
  excerpt: string;
  reason: string;
}
export function parseAnchor(value: unknown): ContentAnchor {
  const raw = asData(value);
  const result: ContentAnchor = { documentId: asString(raw.documentId) };
  for (const key of ['objectId', 'subObjectId', 'blockId', 'excerpt', 'prefix', 'suffix', 'documentHash','sequenceId','itemId','panelId','shotId'] as const) {
    const text = asString(raw[key]);
    if (text) result[key] = text.slice(0, key === 'excerpt' ? 4000 : key === 'prefix' || key === 'suffix' ? 160 : 200);
  }
  if (typeof raw.sourceRevision === 'string') result.sourceRevision = raw.sourceRevision;
  for(const key of ['localMs','panelLocalMs'] as const){const n=raw[key];if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=86400000)result[key]=n;}if(raw.draft===true)result.draft=true;
  return result;
}
export function anchorFromText(snapshot: ProjectSnapshot, documentId: string, excerpt: string, blockId?: string): ContentAnchor {
  const doc = snapshot.documents.find(d => d.id === documentId);
  const quote = excerpt.trim().slice(0, 4000);
  const at = quote && doc ? doc.text.indexOf(quote) : -1;
  const unique = at >= 0 && doc!.text.indexOf(quote, at + quote.length) < 0;
  return { documentId, ...(blockId ? { blockId } : {}), excerpt: quote,
    documentHash: doc?.hash, sourceRevision: snapshot.revision,
    ...(unique ? { prefix: doc!.text.slice(Math.max(0, at - 80), at), suffix: doc!.text.slice(at + quote.length, at + quote.length + 80) } : {}) };
}
export function resolveAnchor(snapshot: ProjectSnapshot, input: unknown): ResolvedAnchor {
  const anchor = parseAnchor(input);
  const base: ResolvedAnchor = { state: 'missing', documentId: anchor.documentId, excerpt: anchor.excerpt ?? '', reason: '来源文档不存在。' };
  let doc = snapshot.documents.find(d => d.id === anchor.documentId);
  if (anchor.objectId) {
    const objects = buildCreativeIndex(snapshot).objects.filter(o => o.object.id === anchor.objectId);
    if (objects.length !== 1) return { ...base, state: objects.length ? 'ambiguous' : 'missing', reason: '源对象已移除或身份重复；没有猜测相邻对象。' };
    const object = objects[0];
    const containsId=(v:unknown):boolean=>Array.isArray(v)?v.some(containsId):!!v&&typeof v==='object'&&(asData(v).id===anchor.subObjectId||Object.values(asData(v)).some(containsId));
    if (anchor.subObjectId && !containsId(object.object.data))
      return { ...base, documentId: object.documentId, objectId: anchor.objectId, reason: '源对象仍存在，但所选画面／标记已经移除。' };
    return { ...base, state: object.documentId === anchor.documentId ? 'matched' : 'relocated', documentId: object.documentId,
      objectId: anchor.objectId, start: object.start, end: object.end, reason: '按稳定对象身份定位。' };
  }
  if (!doc) return base;
  let start = 0, end = doc.text.length;
  if (anchor.blockId) {
    const nodes = fromMarkdown(doc.text).children;
    const marker = `<!-- cewen:block ${anchor.blockId} -->`;
    const matches = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.type === 'html' && n.value.trim() === marker);
    if (matches.length > 1) return { ...base, state: 'ambiguous', reason: '块身份重复，请人工重定位。' };
    if (matches.length === 1) {
      const next = nodes[matches[0].i + 1];
      if (next?.position) { start = next.position.start.offset!; end = next.position.end.offset!; }
      else return { ...base, reason: '块标记存在，但正文已移除。' };
    } else if (!anchor.excerpt) return { ...base, reason: '源块已移除，请重新指定来源。' };
  }
  const quote = anchor.excerpt?.trim();
  if (!quote) return { ...base, state: anchor.documentHash === doc.hash ? 'matched' : 'relocated', blockId: anchor.blockId,
    start, end, reason: anchor.blockId ? '按稳定块身份定位。' : '这是文档级问题，没有绑定某一句话。' };
  const find = (lo: number, hi: number) => {
    const hits: number[] = []; let at = doc!.text.indexOf(quote, lo);
    while (at >= lo && at + quote.length <= hi && hits.length < 200) { hits.push(at); at = doc!.text.indexOf(quote, at + quote.length); }
    return hits;
  };
  let hits = find(start, end);
  if (!hits.length && (start !== 0 || end !== doc.text.length)) hits = find(0, doc.text.length);
  if (hits.length > 1 && (anchor.prefix || anchor.suffix)) hits = hits.filter(at =>
    (!anchor.prefix || doc!.text.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix) &&
    (!anchor.suffix || doc!.text.slice(at + quote.length, at + quote.length + anchor.suffix.length) === anchor.suffix));
  if (hits.length !== 1) return { ...base, state: hits.length ? 'ambiguous' : 'missing',
    reason: hits.length ? '摘录在多处出现，未自动选择。请明确重新关联。' : '原摘录已经改写或移除。原问题与回答保留，请人工重定位。' };
  return { ...base, state: anchor.documentHash === doc.hash ? 'matched' : 'relocated', blockId: anchor.blockId,
    start: hits[0], end: hits[0] + quote.length, reason: '按唯一摘录及上下文定位，没有模糊猜测。' };
}
export const anchorFingerprint = (anchor: ContentAnchor) => contentHash(JSON.stringify(anchor));
