import { collectMediaFromTexts, MEDIA_PATH } from '../shared/creative/content.ts';
import { readHeader } from '../shared/markdown.ts';
import { randomUUID, mkdir, readdir, rename, cp, rm, path, Buffer } from './platform.ts';
import { DOCUMENT_FORMAT, type CommitRequest, type RevisionManifest } from '../shared/model.ts';
import { assertPublicFilePath, fingerprint, hashFiles, optionalBytes, ProjectError, resolveInside, sha256, writeBytes } from './files.ts';
import { companionKind, validateCompanionFile } from '../shared/document-companion.ts';

/** 版本列表保留损坏条目供用户处理，不把它们混入可信版本轴。 */
export interface HistoryEntry { manifest: RevisionManifest; valid: boolean; problem?: string }

/** 网页目录发布可能被关闭页面打断；两端都可按完整暂存清单补齐，不覆盖不同内容。 */
export async function recoverPublishedSnapshots(root: string) {
  let names: string[];
  try { names = await readdir(await resolveInside(root, '.cewen/snapshots')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const staged = `.cewen/snapshots/${name}`, raw = await optionalBytes(root, `${staged}/manifest.json`);
    if (!raw) continue;
    const manifest = JSON.parse(raw.toString('utf8')) as RevisionManifest;
    if (manifest.state !== 'complete' || manifest.id !== name || !/^V\d{6,}$/.test(manifest.label) || !manifest.files || !manifest.files['PROJECT.md'] || !manifest.files['README.md']) throw new ProjectError('HISTORY_DAMAGED', '版本暂存清单无效，已保留原文件。');
    const target = `versions/${manifest.label}`, published = await optionalBytes(root, `${target}/manifest.json`);
    if (published && sha256(published) !== sha256(raw)) throw new ProjectError('HISTORY_DAMAGED','相同版本目录已有其他完成记录，已停止覆盖。');
    for (const [relative, hash] of Object.entries(manifest.files)) {
      if (relative !== 'PROJECT.md' && relative !== 'README.md' && !relative.startsWith('docs/')) throw new ProjectError('INVALID_PATH','版本清单包含不支持的路径。');
      if (relative.startsWith('docs/')) assertPublicFilePath(relative);
      const source = await optionalBytes(root, `${staged}/${relative}`), existing = await optionalBytes(root, `${target}/${relative}`);
      if (!source || sha256(source) !== hash || existing && sha256(existing) !== hash) throw new ProjectError('HISTORY_DAMAGED', `暂存与目标版本校验不一致：${relative}`);
      if (companionKind(relative)) validateCompanionFile(relative, new TextDecoder('utf-8', { fatal: true }).decode(source));
    }
    await mkdir(await resolveInside(root,target),{recursive:true});
    for (const relative of Object.keys(manifest.files)) {
      await mkdir(path.dirname(await resolveInside(root,`${target}/${relative}`)),{recursive:true});
      await cp(await resolveInside(root,`${staged}/${relative}`),await resolveInside(root,`${target}/${relative}`),{force:true});
    }
    await writeBytes(root,`${target}/manifest.json`,raw);
    await rm(await resolveInside(root,staged),{recursive:true});
  }
}

/** 校验完整清单及项目身份，历史阅读不接受目录名作为完成凭据。 */
export async function history(root: string, projectId: string, verify = true): Promise<HistoryEntry[]> {
  await mkdir(await resolveInside(root, 'versions'), { recursive: true });
  const names = (await readdir(await resolveInside(root, 'versions'))).filter(name => /^V\d{6,}$/.test(name)).sort();
  const result: HistoryEntry[] = [];
  let parent: string | null = null;
  for (const label of names) {
    let manifest: RevisionManifest;
    try {
      const source = await optionalBytes(root, `versions/${label}/manifest.json`);
      if (!source) throw new Error('缺少最后写入的完成记录。');
      manifest = JSON.parse(source.toString('utf8')) as RevisionManifest;
      if (manifest.state !== 'complete' || ![1,2].includes(manifest.format) || manifest.projectId !== projectId || manifest.label !== label || typeof manifest.id !== 'string' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || typeof manifest.reason !== 'string' || typeof manifest.requestId !== 'string' || typeof manifest.requestHash !== 'string' || !Array.isArray(manifest.changedPaths) || manifest.changedPaths.some(name => typeof name !== 'string') || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('版本身份、格式或完成标记不正确。');
      if (manifest.parent !== parent) throw new Error('父版本链不完整，不能认定为可信连续历史。');
      if (verify) {
        const verifiedTextFiles = new Map<string, Buffer>();
        for (const [relative, hash] of Object.entries(manifest.files)) {
          if (relative !== 'PROJECT.md' && relative !== 'README.md' && !relative.startsWith('docs/')) throw new Error('历史文件清单包含不支持的路径。');
          if (relative.startsWith('docs/')) assertPublicFilePath(relative);
          const content = await optionalBytes(root, `versions/${label}/${relative}`);
          if (!content || sha256(content) !== hash) throw new Error(`文件校验失败：${relative}`);
          if (relative !== 'README.md') verifiedTextFiles.set(relative, content);
          if (companionKind(relative)) validateCompanionFile(relative, new TextDecoder('utf-8', { fatal: true }).decode(content));
        }
        if (manifest.format === 2) {
          for (const [name, hash] of Object.entries(manifest.media ?? {})) if (!MEDIA_PATH.test(name) || MEDIA_PATH.exec(name)![1] !== hash) throw new Error('历史媒体地址无效');
          const referencedMedia = collectMediaFromTexts(verifiedTextFiles);
          if (JSON.stringify(Object.entries(referencedMedia).sort()) !== JSON.stringify(Object.entries(manifest.media ?? {}).sort())) throw new Error('历史媒体清单与该修订正文描述不一致');
        }
        if (!manifest.files['PROJECT.md'] || !manifest.files['README.md']) throw new Error('版本快照缺少项目说明或变更说明。');
        const currentHashes = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== 'README.md'));
        if (fingerprint(currentHashes) !== manifest.fingerprint) throw new Error('快照指纹与内容清单不一致。');
      }
      result.push({ manifest, valid: true }); parent = manifest.id;
    } catch (error) {
      // 缺损目录仍有可见记录；恢复与提案不得在这样的历史上继续悄悄提交。
      const partial = await optionalBytes(root, `versions/${label}/manifest.json`);
      let saved: Partial<RevisionManifest> = {};
      try { saved = partial ? JSON.parse(partial.toString('utf8')) : {}; } catch { /* 损坏清单保留原文件。 */ }
      result.push({ manifest: { ...saved, label, id: typeof saved.id === 'string' ? saved.id : `invalid-${label}` } as RevisionManifest, valid: false, problem: error instanceof Error ? error.message : '历史校验失败。' });
    }
  }
  return result;
}

/** 完成快照后一次发布目录；当前文件的逐个写入仍由外层事务日志保护。 */
export async function publishRevision(root: string, projectId: string, current: Map<string, Buffer>, request: Pick<CommitRequest, 'requestId' | 'actor' | 'reason' | 'restoredFrom'>, requestHash: string, changedPaths: string[]): Promise<RevisionManifest> {
  const entries = await history(root, projectId);
  if (entries.some(entry => !entry.valid)) throw new ProjectError('HISTORY_DAMAGED', '历史存在未完成或损坏版本，请先处理后再提交。');
  const previous = entries.at(-1)?.manifest;
  const hashes = hashFiles(current);
  const label = `V${String((previous ? Number(previous.label.slice(1)) : 0) + 1).padStart(6, '0')}`;
  const id = randomUUID(), createdAt = new Date().toISOString();
  const staged = `.cewen/snapshots/${id}`;
  await mkdir(await resolveInside(root, staged), { recursive: true });
  for (const [relative, bytes] of current) await writeBytes(root, `${staged}/${relative}`, bytes);
  const explanation = `# ${label} · ${request.reason.replace(/[\r\n]+/g, ' ')}\n\n- 时间：${createdAt}\n- 来源：${{ user: '手工保存', external: '外部文件修改', import: '资料导入', restore: '恢复历史', llm: '模型协作' }[request.actor]}\n- 稳定修订 ID：${id}\n${request.restoredFrom ? `- 恢复来源修订：${request.restoredFrom}\n` : ''}- 上一版本：${previous ? `[${previous.label}](../${previous.label}/README.md)` : '初始版本'}\n\n## 改动文件\n\n${changedPaths.map(name => `- ${name}`).join('\n') || '- 建立项目版本'}\n\n## 阅读\n\n[项目说明](PROJECT.md) · [当前版本文档约定](docs/README.md)\n`;
  await writeBytes(root, `${staged}/README.md`, explanation);
  const format = Number(readHeader(current.get('PROJECT.md')!.toString('utf8')).metadata.format);
  const media = format === 2 ? collectMediaFromTexts(current) : {};
  for (const [name, hash] of Object.entries(media)) { const bytes = await optionalBytes(root, name); if (!bytes || sha256(bytes) !== hash) throw new ProjectError('MEDIA_MISSING', `媒体缺失或损坏：${name}`); }
  const manifest: RevisionManifest = { format, ...(format === 2 ? { media } : {}), state: 'complete', projectId, id, label, parent: previous?.id ?? null, createdAt, actor: request.actor, reason: request.reason, requestId: request.requestId, requestHash, bytes: [...current.values()].reduce((total, bytes) => total + bytes.byteLength, 0) + Buffer.byteLength(explanation), files: { ...hashes, 'README.md': sha256(explanation) }, fingerprint: fingerprint(hashes), changedPaths, ...(request.restoredFrom ? { restoredFrom: request.restoredFrom } : {}) };
  // 完成清单最后生成；没有它的暂存目录不属于可选择的历史版本。
  await writeBytes(root, `${staged}/manifest.json`, JSON.stringify(manifest, null, 2));
  await rename(await resolveInside(root, staged), await resolveInside(root, `versions/${label}`));
  await rebuildHistoryIndex(root, [...entries.map(entry => entry.manifest), manifest]);
  return manifest;
}

/** 历史读取只使用校验清单中的文件，不把后来偷偷放入的内容混进旧版本。 */
export async function readRevision(root: string, projectId: string, revision: string) {
  const entry = (await history(root, projectId)).find(entry => entry.manifest.id === revision || entry.manifest.label === revision);
  if (!entry?.valid) throw new ProjectError('INVALID_REVISION', entry?.problem ?? '找不到这个完整版本。');
  const files = new Map<string, Buffer>();
  for (const [name, hash] of Object.entries(entry.manifest.files)) {
    if (name === 'README.md') continue;
    const bytes = await optionalBytes(root, `versions/${entry.manifest.label}/${name}`);
    if (!bytes || sha256(bytes) !== hash) throw new ProjectError('HISTORY_DAMAGED', '读取期间历史文件发生了变化。');
    files.set(name, bytes);
  }
  return { manifest: entry.manifest, files };
}

/** 索引只做导航；命名基线的权威记录放在独立公开文件中。 */
export async function rebuildHistoryIndex(root: string, entries: RevisionManifest[]) {
  const escapeCell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const text = `# 版本历史\n\n[命名基线](BASELINES.md)\n\n| 版本 | 时间 | 来源 | 修改说明 |\n|---|---|---|---|\n${entries.map(entry => `| [${entry.label}](${entry.label}/README.md) | ${entry.createdAt} | ${entry.actor} | ${escapeCell(entry.reason)} |`).join('\n')}\n`;
  await writeBytes(root, 'versions/INDEX.md', text);
  if (!(await optionalBytes(root, 'versions/BASELINES.md'))) await writeBytes(root, 'versions/BASELINES.md', '# 命名基线\n\n基线引用稳定修订 ID；新增、改名和取消均保留记录。\n\n| 基线 ID | 名称 | 修订 ID | 操作 | 时间 |\n|---|---|---|---|---|\n');
}
