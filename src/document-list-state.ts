import type { ProjectSnapshot, WorkspaceState } from '../shared/model';
import { getRootDocumentId } from '../shared/project-hierarchy';
import { isTransientProject } from '../shared/transient';
import type { DocumentSort } from '../shared/document-order';
import { readWorkspace } from './project-client';

/** 收藏分组属于个人整理，一份文档可同时加入多个分组，不改变正式分类。 */
export interface FavoriteCategory {
  id: string; label: string; color: string; documents: string[];
  /** 收藏分类承接旧集合的层级、说明及顺序，文档成员仍可同时属于多个分类。 */
  parent?: string; description?: string; order?: number;
  /** 原集合的附加属性只保存为个人整理信息，迁移不改写项目 workspace。 */
  sourceCollectionId?: string; scope?: 'personal' | 'project'; tags?: string[]; state?: string; createdAt?: string; updatedAt?: string;
}
export interface DocumentListState {
  sort: DocumentSort;
  favorites: string[];
  recent: string[];
  favoriteCategories: FavoriteCategory[];
  globalPins: string[];
  categoryPins: Record<string, string[]>;
  pinnedGroups: string[];
  /** 已导入的旧集合只记录来源身份，删除收藏分类或取消收藏后不会反复恢复。 */
  importedCollectionIds: string[];
}
const states = new Map<string, DocumentListState>();
const collectionLoads = new Map<string, Promise<DocumentListState>>();
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
const key = (projectId: string) => `cewen-document-list:${projectId}`;

/** 同项目的两个目录和卡片库共享一个偏好对象；临时示例只保存在内存。 */
export function readDocumentListState(snapshot: ProjectSnapshot): DocumentListState {
  const projectId = snapshot.project.id, cached = states.get(projectId);
  if (cached) return cached;
  let raw: Partial<DocumentListState> = {};
  let legacy: Record<string, unknown> = {};
  if (!isTransientProject(projectId)) try {
    raw = JSON.parse(localStorage.getItem(key(projectId)) ?? '{}');
    legacy = JSON.parse(localStorage.getItem(`cewen-directory:${projectId}`) ?? '{}');
  } catch { /* 无法读取个人偏好时仍允许打开公开文档。 */ }
  if (!raw || typeof raw !== 'object') raw = {};
  if (!legacy || typeof legacy !== 'object') legacy = {};
  const root = getRootDocumentId(snapshot);
  const categories: FavoriteCategory[] = Array.isArray(raw.favoriteCategories) ? raw.favoriteCategories.filter(category => category && typeof category.id === 'string' && typeof category.label === 'string').map(category => ({
    id: category.id, label: category.label, color: /^#[0-9a-f]{6}$/i.test(category.color) ? category.color : '#94A5BC', documents: ids(category.documents),
    ...(typeof category.parent === 'string' && category.parent ? { parent: category.parent } : {}),
    ...(typeof category.description === 'string' ? { description: category.description } : {}),
    ...(typeof category.order === 'number' && Number.isFinite(category.order) ? { order: category.order } : {}),
    ...(typeof category.sourceCollectionId === 'string' ? { sourceCollectionId: category.sourceCollectionId } : {}),
    ...(['personal','project'].includes(category.scope ?? '') ? { scope: category.scope } : {}),
    ...(Array.isArray(category.tags) ? { tags: ids(category.tags) } : {}),
    ...(typeof category.state === 'string' ? { state: category.state } : {}),
    ...(typeof category.createdAt === 'string' ? { createdAt: category.createdAt } : {}),
    ...(typeof category.updatedAt === 'string' ? { updatedAt: category.updatedAt } : {}),
  })) : [];
  const state: DocumentListState = {
    sort: ['manual', 'name', 'created', 'updated'].includes(raw.sort ?? '') ? raw.sort! : 'name',
    favorites: [...new Set([...ids(raw.favorites ?? legacy.favorites), ...categories.flatMap(category => category.documents)])],
    recent: ids(raw.recent ?? legacy.recent),
    favoriteCategories: categories,
    globalPins: raw.globalPins === undefined ? snapshot.project.isExample && root ? [root] : [] : ids(raw.globalPins),
    categoryPins: raw.categoryPins && typeof raw.categoryPins === 'object' && !Array.isArray(raw.categoryPins) ? Object.fromEntries(Object.entries(raw.categoryPins).map(([scope, values]) => [scope, ids(values)])) : {},
    pinnedGroups: ids(raw.pinnedGroups ?? legacy.pinned),
    importedCollectionIds: ids(raw.importedCollectionIds),
  };
  states.set(projectId, state);
  return state;
}

/** 只在用户改变偏好时落盘；同步事件让隐藏的另一份目录及卡片库随即更新。 */
export function saveDocumentListState(snapshot: ProjectSnapshot, state: DocumentListState): void {
  states.set(snapshot.project.id, state);
  if (!isTransientProject(snapshot.project.id)) try { localStorage.setItem(key(snapshot.project.id), JSON.stringify(state)); }
  catch { /* 存储空间不足不阻断文档打开与编辑。 */ }
  window.dispatchEvent(new CustomEvent('cewen:document-list-change', { detail: { projectId: snapshot.project.id } }));
}

/** 每个分类或收藏分组有独立图钉；总置顶单独保存，避免混淆两种用途。 */
export function documentPinScope(tab: string, group = ''): string { return `${tab}:${group || 'all'}`; }

/** 只把旧集合的文档引用导入个人收藏分类，原 workspace 记录和项目文件保持原样。 */
export function importCollectionFavorites(snapshot: ProjectSnapshot, workspace: WorkspaceState): DocumentListState {
  const state = readDocumentListState(snapshot); if (snapshot.historical) return state;
  const documents = new Set(snapshot.documents.map(doc => doc.id)), nodes = new Map(snapshot.nodes.filter(node => node.kind !== 'system').map(node => [node.id, node.documentId]));
  let changed = false;
  for (const collection of workspace.items.filter(item => item.kind === 'collection')) {
    if (state.importedCollectionIds.includes(collection.id)) continue;
    // 章节或规则折回所属文档；分类节点不能映射成总纲。未知身份仍保留，避免丢掉原成员。
    const members = ids(collection.targets.map(target => documents.has(target) ? target : nodes.get(target) || target));
    const id = `favorite-collection-${collection.id}`, existing = state.favoriteCategories.find(category => category.id === id);
    if (existing) existing.documents = [...new Set([...existing.documents, ...members])];
    else state.favoriteCategories.push({
      id, label: collection.title || '原集合', color: '#79B6A5', documents: members,
      sourceCollectionId: collection.id, ...(collection.parent ? { parent: `favorite-collection-${collection.parent}` } : {}),
      description: collection.text, ...(typeof collection.order === 'number' ? { order: collection.order } : {}),
      scope: collection.scope, tags: [...collection.tags], state: collection.state, createdAt: collection.createdAt, updatedAt: collection.updatedAt,
    });
    state.favorites = [...new Set([...state.favorites, ...members])];
    state.importedCollectionIds.push(collection.id); changed = true;
  }
  if (changed) saveDocumentListState(snapshot, state);
  return state;
}

/** 收藏分类的祖先链只用于视图筛选和防环，不限制层级深度。 */
export function favoriteCategoryAncestors(categories: FavoriteCategory[], id: string): FavoriteCategory[] {
  const byId = new Map(categories.map(category => [category.id, category])), seen = new Set([id]), result: FavoriteCategory[] = [];
  let parent = byId.get(id)?.parent;
  while (parent) { if (seen.has(parent)) break; seen.add(parent); const category = byId.get(parent); if (!category) break; result.unshift(category); parent = category.parent; }
  return result;
}

/** 同一项目每次会话只读取一次旧集合，目录反复重绘不增加请求；失败仍允许下次重试。 */
export function loadCollectionFavorites(snapshot: ProjectSnapshot): Promise<DocumentListState> {
  if (snapshot.historical) return Promise.resolve(readDocumentListState(snapshot));
  const existing = collectionLoads.get(snapshot.project.id); if (existing) return existing;
  const work = readWorkspace(snapshot.project.id).then(workspace => importCollectionFavorites(snapshot, workspace)).catch(error => { collectionLoads.delete(snapshot.project.id); throw error; });
  collectionLoads.set(snapshot.project.id, work); return work;
}
