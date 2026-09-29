import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { readHeader } from '../shared/markdown';
import { buildCreativeIndex } from '../shared/creative/content';
import { asStrings } from '../shared/creative/model';
import { parseAnchor } from '../shared/creative/anchors';
import { groupAncestors } from '../shared/project-hierarchy';

/** 策问筛选和阅读目录完全独立；特殊范围表示全项目平铺或没有有效普通来源。 */
export type QuestionFilter = 'all' | 'pending' | 'draft' | 'submitted' | 'review';
export interface QuestionDirectoryState {
  group: string; documentId: string; questionId: string;
  filter: QuestionFilter; query: string; includeArchived: boolean;
}
/** 状态由问答控制器提供，目录和模型不能通过改写正文推导或提交答案。 */
export interface QuestionStateInfo {
  id: string; status: 'pending' | 'draft' | 'submitted' | 'review' | 'deferred' | 'premise';
  sourceIds: string[]; blocked?: boolean; reason?: string;
}
export type QuestionRecords = Readonly<Record<string, QuestionStateInfo>> | readonly QuestionStateInfo[];
export const questionFilterLabels: Record<QuestionFilter, string> = { all: '全部', pending: '待答', draft: '草稿', submitted: '已答', review: '待复核' };
export const questionStatusLabels: Record<QuestionStateInfo['status'], string> = { pending: '待答', draft: '草稿', submitted: '已答', review: '待复核', deferred: '暂缓草稿', premise: '前提不成立草稿' };

/** 普通来源必须真实存在于当前快照，不把问题、索引、README 或媒体说明当成文档入口。 */
export function questionDocuments(snapshot: ProjectSnapshot): ProjectDocument[] {
  return snapshot.documents.filter(doc => doc.type !== 'question' && !doc.id.startsWith('unidentified:') && !/(^|\/)(?:README|INDEX)\.md$/i.test(doc.path) && !/(^|\/)(?:media|assets)\//i.test(doc.path));
}

type SourceIndex = { documents: ProjectDocument[]; sources: Map<string, string[]> };
const sourceCache = new WeakMap<ProjectSnapshot, SourceIndex>();
function sourcesForSnapshot(snapshot: ProjectSnapshot): SourceIndex {
  const cached = sourceCache.get(snapshot); if (cached?.documents === snapshot.documents) return cached;
  const normal = questionDocuments(snapshot), normalIds = new Set(normal.map(doc => doc.id)), documentIds = new Set(snapshot.documents.map(doc => doc.id));
  const nodes = new Map(snapshot.nodes.filter(node => node.kind !== 'system').map(node => [node.id, node.documentId]));
  const creative = buildCreativeIndex(snapshot), owners = new Map<string, Set<string>>(), objectsByDocument = new Map<string, Set<string>>();
  for (const item of creative.objects) {
    const docs = owners.get(item.object.id) ?? new Set<string>(); docs.add(item.documentId); owners.set(item.object.id, docs);
    const ids = objectsByDocument.get(item.documentId) ?? new Set<string>(); ids.add(item.object.id); objectsByDocument.set(item.documentId, ids);
  }
  // 与 relatedQuestions 共用同一创作引用规则：文档内对象引用的目标也可关联这份文档。
  const relatedObjects = new Map<string, Set<string>>();
  for (const doc of normal) {
    const ids = new Set(objectsByDocument.get(doc.id) ?? []);
    for (const reference of creative.references) if (ids.has(reference.ownerId)) ids.add(reference.targetId);
    relatedObjects.set(doc.id, ids);
  }
  const sources = new Map<string, string[]>();
  for (const question of snapshot.documents.filter(doc => doc.type === 'question')) {
    const meta = readHeader(question.text).metadata, result = new Set<string>();
    for (const target of asStrings(meta.targets)) {
      if (documentIds.has(target)) result.add(target);
      else if (nodes.has(target)) result.add(nodes.get(target)!);
      else if (owners.has(target)) for (const owner of owners.get(target)!) result.add(owner);
      else result.add(target); // 明确但失效的来源身份仍保留，供复核基准与提示使用。
    }
    const objectTargets = asStrings(meta.objectTargets);
    for (const target of objectTargets) {
      const docs = owners.get(target); if (docs?.size) for (const doc of docs) result.add(doc);
      else result.add(target);
    }
    for (const [documentId, ids] of relatedObjects) if (objectTargets.some(id => ids.has(id))) result.add(documentId);
    const anchor = parseAnchor(meta.anchor);
    if (anchor.documentId) result.add(anchor.documentId);
    if (anchor.objectId) {
      const docs = owners.get(anchor.objectId); if (docs?.size) for (const doc of docs) result.add(doc);
      else if (!anchor.documentId) result.add(anchor.objectId);
    }
    // 正文段落和创作模块的显式引用已由共享解析器投影为 references；不从 contains 或布局反推来源。
    for (const edge of snapshot.edges) {
      if (edge.type !== 'references' || (nodes.get(edge.source) ?? edge.source) !== question.id) continue;
      const target = nodes.get(edge.target) ?? edge.target; if (normalIds.has(target)) result.add(target);
    }
    sources.set(question.id, [...result]);
  }
  const value = { documents: snapshot.documents, sources }; sourceCache.set(snapshot, value); return value;
}

/** 返回稳定来源身份，缺失身份不被猜测或删除；调用者以 questionDocuments 判断有效普通来源。 */
export function questionSources(snapshot: ProjectSnapshot, question: ProjectDocument): string[] {
  return [...sourcesForSnapshot(snapshot).sources.get(question.id) ?? []];
}
export function questionRecord(records: QuestionRecords, id: string): QuestionStateInfo | undefined {
  return Array.isArray(records) ? records.find(record => record.id === id) : (records as Readonly<Record<string, QuestionStateInfo>>)[id];
}
export function questionMatchesFilter(record: QuestionStateInfo | undefined, filter: QuestionFilter): boolean {
  const status = record?.status ?? 'pending';
  return filter === 'all' || filter === 'draft' && ['draft', 'deferred', 'premise'].includes(status) || status === filter;
}

/** 同一问题只返回一次；分类汇总自身和后代的正式问题及普通来源文档，不改变问题归属。 */
export function visibleProjectQuestions(snapshot: ProjectSnapshot, state: QuestionDirectoryState, records: QuestionRecords): ProjectDocument[] {
  const normal = new Map(questionDocuments(snapshot).map(doc => [doc.id, doc])), seen = new Set<string>();
  const inGroup = (id: string) => id === state.group || groupAncestors(snapshot, id).some(group => group.id === state.group);
  const query = state.query.trim().toLocaleLowerCase();
  return snapshot.documents.filter(question => {
    if (question.type !== 'question' || seen.has(question.id) || !state.includeArchived && question.status === 'archived') return false;
    seen.add(question.id); const record = questionRecord(records, question.id);
    if (!questionMatchesFilter(record, state.filter)) return false;
    const sourceIds = questionSources(snapshot, question), sources = sourceIds.map(id => normal.get(id)).filter((doc): doc is ProjectDocument => !!doc);
    if (state.group === 'question-unlinked' && sources.length) return false;
    if (state.group && !['question-all', 'question-unlinked'].includes(state.group) && !inGroup(question.system) && !sources.some(doc => inGroup(doc.system))) return false;
    if (state.documentId && !['question-all', 'question-unlinked'].includes(state.group) && !sources.some(doc => doc.id === state.documentId)) return false;
    return !query || [question.id, question.title, readHeader(question.text).body, ...sources.map(doc => doc.title)].some(text => text.toLocaleLowerCase().includes(query));
  });
}
