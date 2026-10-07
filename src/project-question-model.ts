import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { readHeader } from '../shared/markdown';
import { groupAncestors } from '../shared/project-hierarchy';

/** 策问筛选和阅读目录完全独立；特殊范围表示全项目平铺或没有有效普通来源。 */
export type QuestionFilter = 'all' | 'pending' | 'submitted';
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
export const questionFilterLabels: Record<QuestionFilter, string> = { all: '全部', pending: '待答', submitted: '已答' };
export const questionStatusLabels: Record<QuestionStateInfo['status'], string> = { pending: '待答', draft: '已答', submitted: '已答', review: '待答', deferred: '暂缓', premise: '题目有问题' };

/** 旧个人筛选只迁移浏览偏好，不迁移、丢弃或改写回答。 */
export function questionFilter(value: unknown): QuestionFilter {
  return value === 'submitted' || value === 'draft' ? 'submitted' : value === 'pending' || value === 'review' ? 'pending' : 'all';
}

import { questionDocuments, questionSources } from '../shared/question-sources';
export { questionDocuments, questionSources } from '../shared/question-sources';

export function questionRecord(records: QuestionRecords, id: string): QuestionStateInfo | undefined {
  return Array.isArray(records) ? records.find(record => record.id === id) : (records as Readonly<Record<string, QuestionStateInfo>>)[id];
}
export function questionMatchesFilter(record: QuestionStateInfo | undefined, filter: QuestionFilter): boolean {
  const status = record?.status ?? 'pending';
  // 输入即算已答；记录过程不再作为用户需要区分的独立状态。
  return filter === 'all' || filter === 'submitted' && ['draft','submitted','premise'].includes(status) || filter === 'pending' && ['pending','deferred','review'].includes(status);
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
