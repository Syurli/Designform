import type { CreativeIndex, CreativeObject } from './model.ts';
import { asRows, asNumber, asString, asStrings } from './model.ts';

export interface ObjectQuery {
  text?: string; type?: string; status?: string; tag?: string;
  relatedId?: string; questId?: string; missingMedia?: boolean;
  offset?: number; limit?: number;
}
/** 统一索引查询。不因项目预设过滤能力，也不为每个引用重新计数源对象。 */
export function queryObjects(index: CreativeIndex, query: ObjectQuery) {
  const byId = new Map(index.objects.map(o => [o.object.id, o]));
  const text = (query.text ?? '').trim().toLocaleLowerCase();
  const related = query.relatedId ? new Set([query.relatedId]) : undefined;
  if (related) {
    for (const r of index.references) if (r.targetId === query.relatedId || r.ownerId === query.relatedId) { related.add(r.ownerId); related.add(r.targetId); }
  }
  let questTargets: Set<string> | undefined;
  if (query.questId) {
    const quest = byId.get(query.questId)?.object;
    questTargets = new Set([query.questId, ...asStrings(quest?.data.targetIds)]);
    const adjacency=new Map<string,string[]>();for(const r of index.references){const items=adjacency.get(r.ownerId)??[];items.push(r.targetId);adjacency.set(r.ownerId,items);}const queue=[...questTargets];for(let i=0;i<queue.length;i++)for(const target of adjacency.get(queue[i])??[])if(!questTargets.has(target)){questTargets.add(target);queue.push(target);}
  }
  const missing = (o: CreativeObject) => {
    const media = (id: string) => { const target = byId.get(id)?.object; return target?.type === 'media' && !!target.data.path; };
    if (o.type === 'shot') return !asRows(o.data.panels).length || asRows(o.data.panels).some(p => !media(asString(p.mediaId)));
    if (['speech', 'character', 'location', 'map'].includes(o.type)) return !media(asString(o.data.mediaId));
    if (o.type === 'voice') return !media(asString(o.data.sampleMediaId));
    return false;
  };
  const matches = index.objects.filter(({ object: o }) => (!query.type || o.type === query.type) &&
    (!query.status || (o.status ?? 'draft') === query.status) && (!query.tag || asStrings(o.tags).includes(query.tag)) &&
    (!related || related.has(o.id)) && (!questTargets || questTargets.has(o.id)) && (!query.missingMedia || missing(o)) &&
    (!text || `${o.id} ${o.title} ${o.description ?? ''} ${JSON.stringify(o.data)}`.toLocaleLowerCase().includes(text)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0)), limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 24)));
  return { total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null, objects: matches.slice(offset, offset + limit) };
}
export function creativeStatistics(index: CreativeIndex) {
  const types: Record<string, number> = {};
  const media = new Map<string, number>();
  let panels = 0, instances = 0, mediaUses = 0;
  const byId = new Map(index.objects.map(o => [o.object.id, o.object]));
  for (const { object: o } of index.objects) {
    types[o.type] = (types[o.type] ?? 0) + 1;
    if (o.type === 'media') media.set(asString(o.data.sha256, o.id), asNumber(o.data.bytes));
    if (o.type === 'shot') panels += asRows(o.data.panels).length;
    if (o.type === 'sequence') instances += asRows(o.data.items).length;
  }
  for (const r of index.references) if (byId.get(r.targetId)?.type === 'media') mediaUses++;
  return { sourceObjects: index.objects.length, referenceUses: index.references.length, types,
    mapUseInstances: types['map-use'] ?? 0, sequenceInstances: instances, panels,
    uniqueMedia: media.size, mediaUses, mediaBytes: [...media.values()].reduce((a, b) => a + b, 0) };
}
