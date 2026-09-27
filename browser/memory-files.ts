import path from 'path-browserify';
import { Buffer } from 'buffer';

/** 临时项目的完整文件树只保存在内存，绝不挂载 OPFS、IndexedDB 或用户目录。 */
const entries = new Map<string, Buffer | null>([['/memory', null]]);
export const memoryPath = (name: string) => name === '/memory' || name.startsWith('/memory/');
function key(name: string) {
  const normalized = path.resolve(name);
  if (!memoryPath(normalized)) throw Object.assign(new Error('临时项目不能越过内存边界。'), { code: 'EPERM' });
  return normalized;
}
function missing() { return Object.assign(new Error('临时文件不存在。'), { code: 'ENOENT' }); }
export const memoryFiles = {
  mkdir(name: string, recursive = false) {
    const filename = key(name);
    if (entries.has(filename)) { if (recursive && entries.get(filename) === null) return; throw Object.assign(new Error('目标已存在。'), { code: 'EEXIST' }); }
    const parent = path.dirname(filename);
    if (!entries.has(parent)) { if (!recursive) throw missing(); this.mkdir(parent, true); }
    if (entries.get(parent) !== null) throw new Error('父路径不是目录。');
    entries.set(filename, null);
  },
  stat(name: string) {
    const filename = key(name); if (!entries.has(filename)) throw missing(); const value = entries.get(filename)!;
    return { isDirectory: () => value === null, isFile: () => value !== null, isSymbolicLink: () => false, size: value?.length ?? 0 };
  },
  read(name: string) { const value = entries.get(key(name)); if (value == null) throw missing(); return Buffer.from(value); },
  write(name: string, value: string | Uint8Array) { const filename = key(name); this.mkdir(path.dirname(filename), true); entries.set(filename, Buffer.from(value)); },
  list(name: string) {
    const filename = key(name); if (!this.stat(filename).isDirectory()) throw missing();
    return [...entries.keys()].filter(item => item !== filename && path.dirname(item) === filename).map(item => ({ name: path.basename(item), ...this.stat(item) }));
  },
  remove(name: string, recursive = false, force = false) {
    const filename = key(name); if (!entries.has(filename)) { if (force) return; throw missing(); }
    const children = [...entries.keys()].filter(item => item.startsWith(filename + '/'));
    if (children.length && !recursive) throw new Error('目录仍有内容。');
    for (const child of children) entries.delete(child); entries.delete(filename);
  },
};
