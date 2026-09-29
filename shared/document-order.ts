import type { ProjectDocument, ProjectSnapshot, RevisionManifest } from './model.ts';
import { readHeader } from './markdown.ts';

/** 文档目录和卡片库共用排序规则，名称使用中文拼音与数字的自然升序。 */
export type DocumentSort = 'manual' | 'name' | 'created' | 'updated';
export const documentSortLabels: Record<DocumentSort, string> = { manual: '用户顺序', name: '首字母名称', created: '创建时间', updated: '最后修改' };
export const documentNameOrder = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });

/** 全局手工顺序只保存文档身份，不借排序改写分类或父文档关系。 */
export function documentListOrder(snapshot: ProjectSnapshot): string[] {
  try {
    const order = readHeader(snapshot.projectEntry?.text ?? '').metadata.documentListOrder;
    return Array.isArray(order) ? [...new Set(order.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}

/** 旧有同层级手工顺序仍可作为尚未整理的文档的起点。 */
function hierarchyOrder(snapshot: ProjectSnapshot): string[] {
  try {
    const order = readHeader(snapshot.projectEntry?.text ?? '').metadata.documentOrder;
    if (!order || typeof order !== 'object' || Array.isArray(order)) return [];
    const names = [...snapshot.documents].sort((a, b) => documentNameOrder.compare(a.title, b.title)).map(doc => doc.id);
    const recorded = Object.values(order).flatMap(list => Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
    return [...new Set([...recorded, ...names])];
  } catch { return []; }
}

/** 分类置顶优先于任何排序；时间缺失排在有记录的文档之后，同值以名称稳定排序。 */
export function sortDocuments(snapshot: ProjectSnapshot, docs: ProjectDocument[], sort: DocumentSort, pinned: string[] = []): ProjectDocument[] {
  const manual = [...new Set([...documentListOrder(snapshot), ...hierarchyOrder(snapshot)])];
  const rank = new Map(manual.map((id, index) => [id, index]));
  const pins = new Map(pinned.map((id, index) => [id, index]));
  const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  return [...docs].sort((a, b) => {
    if (pins.has(a.id) || pins.has(b.id)) {
      const pin = (pins.get(a.id) ?? docs.length + pinned.length) - (pins.get(b.id) ?? docs.length + pinned.length);
      if (pin) return pin;
    }
    if (sort === 'manual') {
      const difference = (rank.get(a.id) ?? manual.length) - (rank.get(b.id) ?? manual.length);
      if (difference) return difference;
    } else if (sort === 'created' || sort === 'updated') {
      const difference = time(sort === 'created' ? b.createdAt : b.updatedAt) - time(sort === 'created' ? a.createdAt : a.updatedAt);
      if (difference) return difference;
    }
    return documentNameOrder.compare(a.title, b.title) || a.id.localeCompare(b.id);
  });
}

/** 用已验证版本的首次出现和最近内容变化提供时间，网页与桌面不依赖不同的文件系统时间。 */
export function applyDocumentTimes(documents: ProjectDocument[], manifests: RevisionManifest[]): void {
  const times = new Map<string, { createdAt: string; updatedAt: string; hash: string; revisionLabel: string }>();
  for (const manifest of manifests) {
    for (const doc of documents) {
      const hash = manifest.files[doc.path];
      if (!hash) continue;
      const previous = times.get(doc.path);
      times.set(doc.path, { createdAt: previous?.createdAt ?? manifest.createdAt, updatedAt: previous?.hash === hash ? previous.updatedAt : manifest.createdAt, hash, revisionLabel: previous?.hash === hash ? previous.revisionLabel : manifest.label });
    }
  }
  for (const doc of documents) {
    const recorded = times.get(doc.path);
    if (recorded) { doc.createdAt = recorded.createdAt; doc.updatedAt = recorded.updatedAt; doc.revisionLabel = recorded.revisionLabel; }
  }
}
