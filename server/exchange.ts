import { readdir, readFile, lstat, realpath, path, randomUUID, Buffer } from './platform.ts';
import { readHeader, parseKnowledge, type MarkdownFile } from '../shared/markdown.ts';
import { rewriteLinks, diagnoseLinks } from '../shared/links.ts';
import { setMetadata } from '../shared/editing.ts';
import type { CommitRequest, Diagnostic, ProjectSnapshot } from '../shared/model.ts';
import { optionalBytes, ProjectError, resolveInside, sha256, validateRelative, writeBytes } from './files.ts';

/** 导入计划固定实际候选文本和基础哈希，确认后不会重新读取变化中的来源来偷换内容。 */
export interface ImportPlan { id: string; source: string; sourceHash: string; request: CommitRequest; diagnostics: Diagnostic[]; files: { source: string; destination: string; action: string; originalHash: string }[] }

/** 只遍历用户指定目录；符号链接、超大文件及项目私有目录不作为隐含来源。 */
export async function collectFiles(root: string, include: (relative: string) => boolean, maxBytes = 150 * 1024 * 1024) {
  const files = new Map<string, Buffer>(); let total = 0;
  async function walk(relative: string) {
    const directory = relative ? await resolveInside(root, relative) : root;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new ProjectError('LINK_NOT_ALLOWED', '交换目录内不能包含指向其他位置的符号链接。');
      if (!include(name)) continue;
      validateRelative(name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) {
        const absolute = await resolveInside(root, name), stat = await lstat(absolute);
        total += stat.size; if (total > maxBytes || files.size >= 10000) throw new ProjectError('PACKAGE_TOO_LARGE', '本次资料超过 150 MB 或 10000 个文件，请缩小范围。');
        files.set(name, await readFile(absolute));
      }
    }
  }
  await walk(''); return files;
}

/** 纯 Markdown 导入先生成 ID 和路径映射，不把暂存候选伪称为已接入。 */
export async function prepareImport(snapshot: ProjectSnapshot, root: string, directory: string): Promise<ImportPlan> {
  const source = await realpath(directory), projectRoot = await realpath(root);
  if (source === projectRoot || source.startsWith(projectRoot + path.sep)) throw new ProjectError('ALREADY_PROJECT', '项目当前文档的修改通过同步处理，无需再次导入。');
  const files = await collectFiles(source, relative => !relative.split('/').some(part => part.startsWith('.') || ['node_modules', 'versions', 'dist'].includes(part)));
  for (const [name, bytes] of [...files]) if (/(^|\/)(cewen-import|context)\.json$/i.test(name)) {
    const pack = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(pack.documents)) throw new ProjectError('INVALID_IMPORT_JSON', 'JSON 交换包需要 documents 数组。');
    for (const document of pack.documents) { validateRelative(document.path); if (typeof document.text !== 'string' || !document.path.endsWith('.md') || files.has(document.path)) throw new ProjectError('INVALID_IMPORT_JSON', '交换包文档格式或路径重复。'); files.set(document.path, Buffer.from(document.text)); }
  }
  const markdown = [...files].filter(([name]) => /\.md$/i.test(name) && !/(^|\/)(PROJECT|README|INDEX)\.md$/i.test(name));
  if (!markdown.length) throw new ProjectError('NO_DOCUMENTS', '指定目录没有可导入的 GDD / DD Markdown。');
  const id = randomUUID(), changes: CommitRequest['changes'] = [], mapping: ImportPlan['files'] = [], diagnostics: Diagnostic[] = [];
  const existing = new Map(snapshot.documents.map(document => [document.id, document]));
  const candidates: MarkdownFile[] = snapshot.documents.map(document => ({ path: document.path, text: document.text, hash: document.hash }));
  const moves = new Map<string, string>();
  const identities = new Map<string, { id: string; type: string }>();
  for (const [relative, bytes] of markdown) {
    try {
      const header = readHeader(bytes.toString('utf8'));
      const type = ['gdd','dd','question'].includes(String(header.metadata.type)) ? String(header.metadata.type) : /gdd/i.test(relative) ? 'gdd' : /question|问题/i.test(relative) ? 'question' : 'dd';
      const documentId = typeof header.metadata.id === 'string' ? header.metadata.id : `${type}-import-${sha256(relative + '\n' + source).slice(0, 24)}`;
      const old = existing.get(documentId), folder = type === 'gdd' ? 'gdd' : type === 'question' ? 'questions' : 'dd';
      moves.set(relative, old?.path ?? (relative.startsWith('docs/') ? relative : `docs/${folder}/${relative}`));
      identities.set(relative, { id: documentId, type });
    } catch (error) { diagnostics.push({ path: relative, code: 'IMPORT_INVALID', severity: 'error', message: (error as Error).message }); }
  }
  for (const [relative] of files) if (!relative.endsWith('.md') && /\.(png|jpe?g|webp|gif|txt|csv|pdf)$/i.test(relative)) moves.set(relative, relative.startsWith('docs/assets/') ? relative : `docs/assets/import-${sha256(source).slice(0,8)}/${relative.replace(/^assets\//, '')}`);
  const destinations = new Set<string>();
  for (const [relative, bytes] of markdown) {
    try {
      const identity = identities.get(relative); if (!identity) continue;
      const original = bytes.toString('utf8'), header = readHeader(original), old = existing.get(identity.id), destination = moves.get(relative)!;
      validateRelative(destination);
      if (destinations.has(destination.toLowerCase())) throw new Error(`多个来源映射到同一目标：${destination}`);
      destinations.add(destination.toLowerCase());
      const text = rewriteLinks(setMetadata(original, { id: identity.id, type: identity.type, status: header.metadata.status ?? (identity.type === 'question' ? 'open' : 'draft') }), relative, destination, moves);
      mapping.push({ source: relative, destination, action: old ? old.text === text ? '相同，跳过' : '更新已有身份' : '新增', originalHash: sha256(bytes) });
      await writeBytes(root, `.cewen/imports/${id}/sources/${relative}`, bytes);
      if (old?.text === text) continue;
      if (!old && snapshot.files?.[destination]) throw new Error(`目标路径已由其他文档占用：${destination}`);
      changes.push({ path: destination, baseHash: old?.hash ?? null, text });
      const index = candidates.findIndex(file => file.path === destination); if (index >= 0) candidates.splice(index, 1);
      candidates.push({ path: destination, text, hash: sha256(text) });
    } catch (error) { diagnostics.push({ path: relative, code: 'IMPORT_INVALID', severity: 'error', message: error instanceof Error ? error.message : '无法解析来源。' }); }
  }
  for (const [relative, bytes] of files) if (!relative.endsWith('.md') && moves.has(relative)) {
    const destination = moves.get(relative)!, hash = sha256(bytes);
    if (snapshot.files?.[destination] === hash) continue;
    if (snapshot.files?.[destination]) { diagnostics.push({ path: relative, code: 'ASSET_CONFLICT', severity: 'error', message: '同路径附件内容不同，请在来源中改名并修复引用后重新预检。' }); continue; }
    changes.push({ path: destination, baseHash: null, text: bytes.toString('base64'), encoding: 'base64' });
    await writeBytes(root, `.cewen/imports/${id}/sources/${relative}`, bytes);
  }
  diagnostics.push(...parseKnowledge(candidates).diagnostics);
  const publicFiles = new Map<string,string|null>(Object.keys(snapshot.files ?? {}).map(name => [name, null]));
  for (const candidate of candidates) publicFiles.set(candidate.path, candidate.text);
  for (const change of changes) publicFiles.set(change.path, change.encoding ? null : change.text);
  diagnostics.push(...diagnoseLinks(publicFiles));
  const plan: ImportPlan = { id, source, sourceHash: sha256(JSON.stringify([...files].map(([name, bytes]) => [name, sha256(bytes)]))), request: { projectId: snapshot.project.id, requestId: `import-${id}`, baseRevision: snapshot.revision, reason: '导入已审核的 Markdown 资料', actor: 'import', changes }, diagnostics, files: mapping };
  await writeBytes(root, `.cewen/imports/${id}/plan.json`, JSON.stringify(plan, null, 2)); return plan;
}

/** 使用已经审核的暂存计划，来源后续变化不会替换审核过的文本。 */
export async function readImport(root: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ProjectError('INVALID_IMPORT', '导入批次身份无效。');
  const bytes = await optionalBytes(root, `.cewen/imports/${id}/plan.json`);
  if (!bytes) throw new ProjectError('MISSING_IMPORT', '找不到导入预检记录。');
  const plan = JSON.parse(bytes.toString('utf8')) as ImportPlan;
  if (plan.diagnostics.some(issue => issue.severity === 'error')) throw new ProjectError('IMPORT_INVALID', '预检仍有错误，请修正来源后重新预检。', plan.diagnostics);
  return plan;
}
