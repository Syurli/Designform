/** 0.9 创作对象契约：类型描述用途，绝不代表项目权限。 */
export const CREATIVE_SCHEMA = 1;
export const CREATIVE_FORMAT = 2;
export const objectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export type Data = { [key: string]: Value };
export type FieldKind = 'text' | 'longtext' | 'number' | 'select' | 'object' | 'objects' | 'rows';
export interface ModuleField {
  key: string; label: string; kind: FieldKind; required?: boolean; help?: string;
  options?: string[]; objectType?: string; fields?: ModuleField[]; min?: number; max?: number;
}
export interface CreativeObject {
  schema: number; id: string; type: string; title: string; description?: string;
  tags?: string[]; status?: 'draft' | 'confirmed' | 'archived'; data: Data;
  /** 未知顶层字段在局部编辑时保留，不靠解析器重写不认识的数据。 */
  [key: string]: unknown;
}
export interface LocatedObject {
  object: CreativeObject; documentId: string; path: string; documentHash: string;
  start: number; end: number; source: string; hash: string; language: string;
}
export interface ReferenceUse { ownerId: string; targetId: string; role: string; path: string }
export interface CreativeIndex {
  objects: LocatedObject[]; references: ReferenceUse[];
  diagnostics: { path: string; code: string; severity: 'error' | 'warning'; message: string }[];
}
export interface ModuleDefinition {
  type: string; title: string; schemaVersion: number; description: string; fields: ModuleField[];
  create(id: string, title?: string): CreativeObject;
  validate(object: CreativeObject): string[];
  dependencies(object: CreativeObject): { id: string; role: string }[];
  summary(object: CreativeObject): string;
}
export const asString = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const asNumber = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export const asRows = (value: unknown): Data[] => Array.isArray(value) ? value.filter((v): v is Data => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
export const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export const asData = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
