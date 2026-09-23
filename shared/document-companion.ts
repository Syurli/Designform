/** 公开伴随文件只承载布局与视觉注释，不复制文档正文。 */
export interface LayoutCompanion {
  format: 1;
  documentId: string;
  blocks: Record<string, { x: number; y: number; width?: number; height?: number; z?: number; section?: string }>;
  dialogues?: Record<string, Record<string, { x: number; y: number }>>;
}

/** 坐标相对稳定块或章节，便于正文重排后重新定位。 */
export interface InkItem {
  id: string;
  kind: 'stroke' | 'text' | 'image' | 'arrow';
  anchor: { blockId?: string; section?: string };
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  rotation?: number;
  points?: [number, number][];
  text?: string;
  assetPath?: string;
  createdAt: string;
  updatedAt: string;
  resolved?: boolean;
}

/** 视觉笔画与项目共享讨论文字分开保存，便于纯文本阅读者跳过坐标。 */
export interface InkCompanion { format: 1; documentId: string; items: InkItem[] }

export const COMPANION_MAX_BYTES = 2 * 1024 * 1024;
export const companionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const layoutPattern = /^docs\/layouts\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\.json$/;
const inkPattern = /^docs\/annotations\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\.ink\.json$/;
const fieldPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }
function identity(value: unknown): value is string { return typeof value === 'string' && fieldPattern.test(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function point(value: unknown): value is { x: number; y: number } { return record(value) && keys(value, ['x', 'y']) && number(value.x) && number(value.y); }

/** 路径中的 ID 与 JSON 的 documentId 必须一致，不能借写入接口跨目录放置 JSON。 */
export function companionKind(path: string): 'layout' | 'ink' | null { return layoutPattern.test(path) ? 'layout' : inkPattern.test(path) ? 'ink' : null; }
export function companionDocumentId(path: string): string | null { return layoutPattern.exec(path)?.[1] ?? inkPattern.exec(path)?.[1] ?? null; }
export function layoutCompanionPath(documentId: string) { if (!companionIdPattern.test(documentId)) throw new Error('伴随文件文档 ID 无效。'); return `docs/layouts/${documentId}.json`; }
export function inkCompanionPath(documentId: string) { if (!companionIdPattern.test(documentId)) throw new Error('伴随文件文档 ID 无效。'); return `docs/annotations/${documentId}.ink.json`; }

/** 布局属性只允许有限数值及稳定身份，不接受正文副本或任意扩展字段。 */
export function validateLayoutCompanion(value: unknown, path?: string): value is LayoutCompanion {
  if (!record(value) || !keys(value, ['format', 'documentId', 'blocks', 'dialogues']) || value.format !== 1 || !identity(value.documentId) || (path && path !== layoutCompanionPath(value.documentId)) || !record(value.blocks)) return false;
  if (!Object.entries(value.blocks).every(([id, position]) => identity(id) && record(position) && keys(position, ['x', 'y', 'width', 'height', 'z', 'section']) && number(position.x) && number(position.y) && (position.width === undefined || number(position.width) && position.width > 0) && (position.height === undefined || number(position.height) && position.height > 0) && (position.z === undefined || number(position.z)) && (position.section === undefined || identity(position.section)))) return false;
  return value.dialogues === undefined || record(value.dialogues) && Object.entries(value.dialogues).every(([dialogueId, positions]) => identity(dialogueId) && record(positions) && Object.entries(positions).every(([nodeId, position]) => identity(nodeId) && point(position)));
}

/** 限制资源引用为项目附件，避免视觉注释成为任意文件读取入口。 */
export function validateInkCompanion(value: unknown, path?: string): value is InkCompanion {
  if (!record(value) || !keys(value, ['format', 'documentId', 'items']) || value.format !== 1 || !identity(value.documentId) || (path && path !== inkCompanionPath(value.documentId)) || !Array.isArray(value.items)) return false;
  const seen = new Set<string>();
  return value.items.every(item => {
    if (!record(item) || !keys(item, ['id', 'kind', 'anchor', 'x', 'y', 'width', 'height', 'color', 'opacity', 'rotation', 'points', 'text', 'assetPath', 'createdAt', 'updatedAt', 'resolved']) || !identity(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    if (!['stroke', 'text', 'image', 'arrow'].includes(String(item.kind)) || !record(item.anchor) || !keys(item.anchor, ['blockId', 'section']) || (item.anchor.blockId !== undefined && !identity(item.anchor.blockId)) || (item.anchor.section !== undefined && !identity(item.anchor.section))) return false;
    if (![item.x, item.y, item.width, item.height, item.opacity].every(number) || (item.width as number) < 0 || (item.height as number) < 0 || (item.opacity as number) < 0 || (item.opacity as number) > 1) return false;
    if (typeof item.color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(item.color) || (item.rotation !== undefined && !number(item.rotation)) || (item.resolved !== undefined && typeof item.resolved !== 'boolean')) return false;
    if (item.points !== undefined && (!Array.isArray(item.points) || item.points.length > 20000 || !item.points.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(number)))) return false;
    if (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 20000)) return false;
    if (item.assetPath !== undefined && (typeof item.assetPath !== 'string' || !/^docs\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp|gif)$/i.test(item.assetPath) || item.assetPath.includes('..') || /(?:^|\/)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\/|$)/i.test(item.assetPath))) return false;
    return typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt));
  });
}

/** 保存与外部修改共用同一解析入口，超限或无效文件不进入版本。 */
export function validateCompanionFile(path: string, text: string): LayoutCompanion | InkCompanion {
  const kind = companionKind(path);
  if (!kind || typeof text !== 'string' || new TextEncoder().encode(text).byteLength > COMPANION_MAX_BYTES) throw new Error('伴随文件路径或大小无效。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('伴随文件不是有效 JSON。'); }
  if (kind === 'layout' && validateLayoutCompanion(value, path)) return value;
  if (kind === 'ink' && validateInkCompanion(value, path)) return value;
  throw new Error('伴随文件格式、文档 ID 或字段无效。');
}
export function parseLayoutCompanion(text: string, path?: string): LayoutCompanion {
  const value = path ? validateCompanionFile(path, text) : JSON.parse(text) as unknown;
  if (!validateLayoutCompanion(value, path)) throw new Error('公开排版格式无效。');
  return value;
}
export function parseInkCompanion(text: string, path?: string): InkCompanion {
  const value = path ? validateCompanionFile(path, text) : JSON.parse(text) as unknown;
  if (!validateInkCompanion(value, path)) throw new Error('公开笔画格式无效。');
  return value;
}
