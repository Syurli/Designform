import {buildCreativeIndex,contentHash} from './creative/content.ts';
import { parseDocument as parseYaml } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, RootContent } from 'mdast';
import { DOCUMENT_FORMAT, HIERARCHY_MAX_DEPTH, type DesignStatus, type Diagnostic, type KnowledgeData, type KnowledgeEdge, type KnowledgeGroup, type KnowledgeNode, type ProjectDocument, type ProjectInfo, type RelationType } from './model.ts';

/** 文件由宿主读取；解析器不接触磁盘，浏览器预检与本地服务可复用。 */
export interface MarkdownFile { path: string; text: string; hash: string }
/** 原始文本偏移用于局部编辑，未识别的内容也必须原样保留。 */
export interface MarkdownHeader { metadata: Record<string, unknown>; body: string; bodyOffset: number }
/** 公开身份字符集；路径与标题不能冒充稳定身份。 */
export const identityPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const palette = ['#EBC58D', '#7CBFFF', '#ED9FAD', '#79D9C3', '#B5A3F5', '#A6C981'];
const relationMap: Record<string, RelationType> = {
  依赖: 'depends', 约束: 'constrains', 关联: 'relates', 引用: 'references', 替代: 'replaces',
  depends: 'depends', constrains: 'constrains', relates: 'relates', references: 'references', replaces: 'replaces',
};

/** 只在文件开头读取 YAML；正文里的分隔线不视为头部。 */
export function readHeader(text: string): MarkdownHeader {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { metadata: {}, body: text, bodyOffset: 0 };
  const document = parseYaml(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error(`文档头部无法解析：${document.errors[0].message}`);
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文档头部必须是字段列表。');
  return { metadata: value as Record<string, unknown>, body: text.slice(match[0].length), bodyOffset: match[0].length };
}

/** 读取人可见的 Markdown 文本；从不执行 HTML 或嵌入脚本。 */
function plain(node: Nodes): string {
  if ('value' in node) return node.type === 'html' ? '' : String(node.value);
  if ('children' in node) return node.children.map(child => plain(child)).join(node.type === 'tableRow' ? ' · ' : '');
  return '';
}

/** 标准 Markdown AST 保留表格和位置，避免正则把代码块中的假标题当规则。 */
function tree(body: string) {
  const result = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // 有些文本编辑器把锚点直接贴在标题上一行；CommonMark 会合并成 HTML 块。
  // 仅拆解 AST 中精确匹配的锚点加标题，不触碰代码块，也不重写用户原文件。
  result.children = result.children.flatMap(node => {
    if (node.type !== 'html') return [node];
    const match = /^(<a\s+id=["'][A-Za-z0-9][A-Za-z0-9_-]{0,119}["']\s*>\s*<\/a>)\r?\n(#{1,6} [^\r\n]+)\s*$/.exec(node.value);
    if (!match) return [node];
    return [{ ...node, value: match[1] }, ...fromMarkdown(match[2]).children];
  });
  // 画布稳定块标记只辅助编辑定位；知识规则仍由原始锚点紧邻的标题定义。
  // 仅从语义节点序列排除合法标记，AST 位置继续指向原文，引用偏移不会漂移。
  result.children = result.children.filter(node => !(node.type === 'html' && /^<!-- cewen:block [A-Za-z0-9][A-Za-z0-9_-]{0,119} -->$/.test(node.value.trim())));
  return result;
}
function string(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function identity(value: unknown) { const valueString = string(value); return identityPattern.test(valueString) ? valueString : ''; }
function statusOf(value: unknown, question = false): DesignStatus {
  if (value === 'archived') return 'archived';
  if (question) return value === 'decided' ? 'confirmed' : 'question';
  return value === 'confirmed' || value === 'question' || value === 'draft' ? value : 'draft';
}
function anchorOf(node: RootContent): string | undefined {
  // 成对空 a 标签通常被 CommonMark 解析成段落中的两个行内 HTML 节点。
  // 只接受整段完全由锚点构成的情况，不把正文里举例的代码当成规则身份。
  const value = node.type === 'html' ? node.value : node.type === 'paragraph' && node.children.every(child => child.type === 'html' || (child.type === 'text' && !child.value.trim())) ? node.children.map(child => 'value' in child ? child.value : '').join('') : '';
  return /^\s*<a\s+id=["']([A-Za-z0-9][A-Za-z0-9_-]{0,119})["']\s*>\s*<\/a>\s*$/.exec(value)?.[1];
}
function titleOf(children: RootContent[], fallback: string) {
  const heading = children.find(node => node.type === 'heading');
  return heading ? plain(heading).trim() || fallback : fallback;
}
function paragraphs(children: RootContent[]) {
  return children.filter(node => node.type === 'paragraph' || node.type === 'list' || node.type === 'blockquote')
    .map(node => plain(node).trim()).filter(Boolean);
}

/** 项目入口是普通 Markdown，编辑器不把安装目录或内部代码路径写入它。 */
export function parseProjectInfo(file: MarkdownFile, path = ''): ProjectInfo {
  const { metadata, body } = readHeader(file.text);
  const id = identity(metadata.id);
  if (!id) throw new Error('PROJECT.md 缺少有效的稳定项目 ID。');
  if (typeof metadata.format !== 'number' || ![1, 2].includes(metadata.format)) throw new Error(`不支持文档格式 ${String(metadata.format)}，请使用对应版本或迁移副本。`);
  const icon = metadata.icon;
  const projectIcon = icon && typeof icon === 'object' && !Array.isArray(icon) && ['text', 'symbol', 'image'].includes(String((icon as Record<string, unknown>).kind)) && typeof (icon as Record<string, unknown>).value === 'string'
    ? { kind: (icon as Record<string, unknown>).kind as 'text' | 'symbol' | 'image', value: (icon as Record<string, string>).value } : undefined;
  return { id, name: string(metadata.name, titleOf(tree(body).children, '未命名项目')), description: string(metadata.description), format: Number(metadata.format), path, isExample: metadata.example === true, ...(projectIcon ? { icon: projectIcon } : {}), notes: string(metadata.notes) };
}

/**
 * 从公开文档重建知识空间。诊断不隐藏原文，也不在只读操作中补 ID 或重写链接。
 * 关系的目标身份独立于路径，因此索引丢失、文件改名后仍可重建正式知识关系。
 */
export function parseKnowledge(files: MarkdownFile[]): KnowledgeData & { documents: ProjectDocument[]; diagnostics: Diagnostic[] } {
  const documents: ProjectDocument[] = [], diagnostics: Diagnostic[] = [];
  const nodes: KnowledgeNode[] = [], edges: KnowledgeEdge[] = [], groups: KnowledgeGroup[] = [];
  const parsed: { file: MarkdownFile; header: MarkdownHeader; children: RootContent[]; document: ProjectDocument }[] = [];
  const docIds = new Set<string>(), edgeIds = new Set<string>(), nodeIds = new Set<string>();
  const issue = (file: string, code: string, message: string, severity: Diagnostic['severity'] = 'error', line?: number) => diagnostics.push({ path: file, code, message, severity, line });
  const projectEntry = files.find(file => file.path === 'PROJECT.md');
  let projectSystems = false;
  if (projectEntry) try {
    const metadata = readHeader(projectEntry.text).metadata;
    projectSystems = Object.hasOwn(metadata, 'systems');
    if (projectSystems) {
      if (!Array.isArray(metadata.systems)) issue('PROJECT.md', 'INVALID_SYSTEM', '分类目录必须是列表。');
      else for (const raw of metadata.systems) {
        const item = raw as Record<string, unknown> | null, id = identity(item?.id);
        if (!id || groups.some(group => group.id === id)) { issue('PROJECT.md', 'INVALID_SYSTEM', '分类身份缺失或重复。'); continue; }
        if (item?.parent !== undefined && item.parent !== '' && !identity(item.parent)) issue('PROJECT.md', 'INVALID_GROUP_PARENT', `分类 ${id} 的父分类 ID 格式无效。`);
        groups.push({ id, label: string(item?.title, id), color: /^#[0-9a-f]{6}$/i.test(string(item?.color)) ? string(item?.color) : palette[groups.length % palette.length], ...(identity(item?.parent) ? { parent: identity(item?.parent) } : {}) });
      }
    }
  } catch (error) { issue('PROJECT.md','PARSE_ERROR', String(error)); }

  for (const file of files.filter(file => file.path.startsWith('docs/') && !file.path.startsWith('docs/annotations/') && /\.md$/i.test(file.path)).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))) {
    try {
      const header = readHeader(file.text), children = tree(header.body).children;
      const rawType = header.metadata.type;
      const type = rawType === 'gdd' || rawType === 'dd' || rawType === 'question' ? rawType : 'guide';
      const id = identity(header.metadata.id);
      if (header.metadata.parent !== undefined && header.metadata.parent !== '' && !identity(header.metadata.parent)) issue(file.path, 'INVALID_DOCUMENT_PARENT', '父文档 ID 格式无效。');
      const color = /^#[0-9a-f]{6}$/i.test(string(header.metadata.color)) ? string(header.metadata.color) : undefined;
      const document: ProjectDocument = { id: id || `unidentified:${file.path}`, path: file.path, title: titleOf(children, file.path.split('/').at(-1)!), type, status: statusOf(header.metadata.status, type === 'question'), system: identity(header.metadata.system), ...(identity(header.metadata.parent) ? { parent: identity(header.metadata.parent) } : {}), text: file.text, hash: file.hash, ...(color ? { color } : {}) };
      documents.push(document);
      if (type === 'guide') continue;
      if (!id) { issue(file.path, 'MISSING_ID', '文档缺少有效 ID；可阅读原文，补齐身份后才能建立稳定关系。'); continue; }
      if (docIds.has(id)) { issue(file.path, 'DUPLICATE_ID', `文档 ID ${id} 已被使用，未自动合并。`); continue; }
      docIds.add(id);
      parsed.push({ file, header, children, document });
      if (!projectSystems && type === 'gdd' && Array.isArray(header.metadata.systems)) {
        for (const raw of header.metadata.systems) {
          if (!raw || typeof raw !== 'object') { issue(file.path, 'INVALID_SYSTEM', '系统目录项必须包含 id 和 title。'); continue; }
          const system = raw as Record<string, unknown>, systemId = identity(system.id);
          if (!systemId || groups.some(group => group.id === systemId)) { issue(file.path, 'INVALID_SYSTEM', '系统 ID 缺失或重复。'); continue; }
          if (system.parent !== undefined && system.parent !== '' && !identity(system.parent)) issue(file.path, 'INVALID_GROUP_PARENT', `分类 ${systemId} 的父分类 ID 格式无效。`);
          groups.push({ id: systemId, label: string(system.title, systemId), color: /^#[0-9a-f]{6}$/i.test(string(system.color)) ? string(system.color) : palette[groups.length % palette.length], ...(identity(system.parent) ? { parent: identity(system.parent) } : {}) });
        }
      }
    } catch (error) {
      issue(file.path, 'PARSE_ERROR', error instanceof Error ? error.message : '文档解析失败。');
      documents.push({ id: `unidentified:${file.path}`, path: file.path, title: file.path.split('/').at(-1)!, type: 'guide', status: 'draft', system: '', text: file.text, hash: file.hash });
    }
  }

  const roots = parsed.filter(item => item.document.type === 'gdd' && item.document.status !== 'archived').sort((a, b) => Number(/\/GDD\.md$/i.test(b.file.path)) - Number(/\/GDD\.md$/i.test(a.file.path)));
  const root = roots[0]?.document;
  if (roots.length > 1) issue(roots[1].file.path, 'MULTIPLE_ROOT', '项目只能有一份当前游戏总纲。');
  // 旧总纲的 system/parent 只保留在原文，不参与层级投影。
  if (root) { root.system = ''; delete root.parent; }
  const groupById = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) if (group.parent) {
    const visited = new Set([group.id]); let parent: string | undefined = group.parent, depth = 1;
    while (parent) {
      const ancestor = groupById.get(parent);
      if (!ancestor || visited.has(parent) || ++depth > HIERARCHY_MAX_DEPTH) { issue(projectSystems ? 'PROJECT.md' : root?.path ?? 'PROJECT.md', 'INVALID_GROUP_PARENT', `分类 ${group.id} 的父分类不存在、成环或超过层级上限。`); delete group.parent; break; }
      visited.add(parent); parent = ancestor.parent;
    }
  }
  const documentById = new Map(parsed.map(item => [item.document.id, item.document]));
  for (const item of parsed) {
    const document = item.document;
    if (document === root || !document.parent) continue;
    const seen = new Set([document.id]); let parent: string | undefined = document.parent;
    while (parent) {
      const ancestor = documentById.get(parent);
      if (!ancestor || ancestor.type === 'gdd' || seen.has(parent)) { issue(item.file.path, 'INVALID_DOCUMENT_PARENT', `文档 ${document.id} 的父文档不存在、指向总纲或形成循环。`); delete document.parent; break; }
      seen.add(parent); parent = ancestor.parent;
    }
  }
  // 父文档决定后代的主要分类；旧稿中不一致的 system 字段保留原文但不误投影。
  const effectiveSystem = (document: ProjectDocument): string => document.parent ? effectiveSystem(documentById.get(document.parent)!) : document.system;
  for (const item of parsed) if (item.document !== root && item.document.parent) item.document.system = effectiveSystem(item.document);
  for (const item of parsed) {
    const document = item.document; if (document === root) continue;
    let depth = 1, parent = document.parent;
    while (parent) { depth++; parent = documentById.get(parent)?.parent; }
    let group = groupById.get(document.system);
    while (group) { depth++; group = group.parent ? groupById.get(group.parent) : undefined; }
    if (depth > HIERARCHY_MAX_DEPTH) issue(item.file.path, 'HIERARCHY_TOO_DEEP', `文档 ${document.id} 超过总纲以下 ${HIERARCHY_MAX_DEPTH} 层。`);
  }
  // 未指定主归属的内容仍可阅读；总纲本身永不归入未归组。
  if (!groups.some(group => group.id === 'system-unassigned') && parsed.some(item => item.document.type !== 'gdd' && (!groups.some(group => group.id === item.document.system) || Object.values(item.header.metadata.sectionSystems && typeof item.header.metadata.sectionSystems==='object' ? item.header.metadata.sectionSystems : {}).includes('system-unassigned')))) groups.push({ id: 'system-unassigned', label: '未归组', color: '#94A5BC' });
  // 图谱的兄弟节点沿用目录的公开顺序。只调整投影遍历，不重排 Markdown 文件或正文。
  // 缺少 documentOrder 的旧项目按标题排序；无效条目忽略，仍交给原有诊断与原文保留。
  let documentOrder: Record<string, string[]> = {};
  try {
    const raw = projectEntry && readHeader(projectEntry.text).metadata.documentOrder;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) documentOrder = Object.fromEntries(Object.entries(raw).filter(([, ids]) => Array.isArray(ids)).map(([key, ids]) => [key, (ids as unknown[]).filter((id): id is string => typeof id === 'string')]));
  } catch { /* PROJECT.md 的解析错误已经单独诊断，知识投影继续使用标题顺序。 */ }
  const orderedParsed: typeof parsed = [], orderedIds = new Set<string>();
  const appendDocument = (item: typeof parsed[number]) => {
    if (orderedIds.has(item.document.id)) return;
    orderedIds.add(item.document.id); orderedParsed.push(item);
    appendSiblings(`document:${item.document.id}`, child => child.document.parent === item.document.id);
  };
  const appendSiblings = (key: string, predicate: (item: typeof parsed[number]) => boolean) => {
    const row = documentOrder[key] ?? [];
    parsed.filter(item => !orderedIds.has(item.document.id) && predicate(item)).sort((a, b) => {
      const left = row.indexOf(a.document.id), right = row.indexOf(b.document.id);
      if (left !== right) return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
      return a.document.title.localeCompare(b.document.title, 'zh-CN') || a.file.path.localeCompare(b.file.path, 'zh-CN');
    }).forEach(appendDocument);
  };
  if (root) { const item = parsed.find(item => item.document.id === root.id); if (item) appendDocument(item); }
  const visitGroup = (id: string) => {
    groups.filter(group => group.parent === id).forEach(group => visitGroup(group.id));
    appendSiblings(id, item => !item.document.parent && item.document.system === id);
  };
  groups.filter(group => !group.parent).forEach(group => visitGroup(group.id));
  parsed.filter(item => !orderedIds.has(item.document.id)).forEach(appendDocument);
  for (const group of groups) {
    nodes.push({ id: group.id, title: group.label, group: group.id, kind: 'system', summary: group.id === 'system-unassigned' ? '尚未指定主要系统的文档。' : `查看${group.label}的文档与规则。`, content: ['设计分类来自公开项目目录；私人工作分组不会修改此结构。'], source: projectSystems ? 'PROJECT.md' : root?.path ?? 'PROJECT.md', status: 'draft', documentId: root?.id ?? '', documentPath: projectSystems ? 'PROJECT.md' : root?.path ?? 'PROJECT.md' });
    nodeIds.add(group.id);
  }

  const appendEdge = (edge: KnowledgeEdge, path: string) => {
    if (edgeIds.has(edge.id)) { issue(path, 'DUPLICATE_RELATION', `关系 ID ${edge.id} 重复，未自动覆盖。`); return; }
    edgeIds.add(edge.id); edges.push(edge);
  };

  for (const { file, header, children, document } of orderedParsed) {
    if (nodeIds.has(document.id)) { issue(file.path, 'DUPLICATE_ID', `文档 ID ${document.id} 与系统身份冲突。`); continue; }
    const group = document.type === 'gdd' ? '' : groups.find(group => group.id === document.system)?.id ?? 'system-unassigned';
    if (document.type !== 'gdd' && document.system && group === 'system-unassigned') issue(file.path, 'UNKNOWN_SYSTEM', `未找到主要系统 ${document.system}，暂列入未归组。`, 'warning');
    const content = paragraphs(children), line = header.bodyOffset ? file.text.slice(0, header.bodyOffset).split('\n').length : 1;
    nodes.push({ id: document.id, title: document.title, kind: 'document', documentType: document.type, group, summary: string(header.metadata.summary) || content[0] || '尚未填写设计正文。', content, source: `${file.path}:${line}`, status: document.status, documentId: document.id, documentPath: file.path, ...(document.color ? { color: document.color } : {}) });
    nodeIds.add(document.id);
    if (document.type !== 'gdd') {
      const parent = document.parent ?? group;
      appendEdge({ id: `contains:${parent}:${document.id}`, source: parent, target: document.id, type: 'contains', note: document.parent ? '来自当前文档的父文档归属。' : '来自当前文档的主要系统归属。', origin: {kind:'classification',path:file.path} }, file.path);
    }

    let owner = document.id;
    const anchors = children.flatMap((node, index) => anchorOf(node) ? [{ index, id: anchorOf(node)! }] : []);
    // 章节仍属于原文档；单独分类只影响知识视图，公开元数据可被其他编辑器与 LLM 读取。
    const sectionSystems = header.metadata.sectionSystems && typeof header.metadata.sectionSystems === 'object' && !Array.isArray(header.metadata.sectionSystems) ? header.metadata.sectionSystems as Record<string, unknown> : {};
    if(Object.hasOwn(header.metadata,'sectionSystems') && (!header.metadata.sectionSystems || typeof header.metadata.sectionSystems!=='object' || Array.isArray(header.metadata.sectionSystems))) issue(file.path,'INVALID_SECTION_SYSTEM','sectionSystems 应为章节锚点到分类身份的映射，请修正后再调整章节分类。','warning');
    for (const [anchor, system] of Object.entries(sectionSystems)) {
      if (!anchors.some(item => item.id === anchor)) issue(file.path, 'UNKNOWN_SECTION', `章节分类 ${anchor} 未找到对应锚点。`, 'warning');
      if (typeof system !== 'string' || !groups.some(item => item.id === system)) issue(file.path, 'UNKNOWN_SYSTEM', `章节 ${anchor} 的分类无效，暂沿用文档分类。`, 'warning');
    }
    for (let index = 0; index < children.length; index++) {
      const child = children[index], anchor = anchorOf(child);
      if (anchor) {
        const next = children[index + 1];
        if (!next || next.type !== 'heading') { issue(file.path, 'ANCHOR_WITHOUT_HEADING', `规则锚点 ${anchor} 后应有规则标题。`); continue; }
        const id = `${document.id}/${anchor}`;
        if (nodeIds.has(id)) { issue(file.path, 'DUPLICATE_ANCHOR', `规则锚点 ${anchor} 重复。`); continue; }
        const endIndex = anchors.find(item => item.index > index)?.index ?? children.length;
        const section = children.slice(index + 1, endIndex), content = paragraphs(section);
        const explicitStatus = content.find(text => /^设计状态[：:]/.test(text));
        const status = explicitStatus?.includes('待确认') ? 'question' : explicitStatus?.includes('已确认') ? 'confirmed' : explicitStatus?.includes('已归档') ? 'archived' : document.status;
        const sourceLine = line + (child.position?.start.line ?? 1) - 1;
        const sectionGroup = groups.find(item => item.id === sectionSystems[anchor])?.id;
        nodes.push({ id, title: plain(next), kind: 'rule', group: sectionGroup ?? group, summary: content.find(text => !/^设计状态[：:]/.test(text)) ?? '尚未填写规则正文。', content, source: `${file.path}:${sourceLine}`, status, documentId: document.id, documentPath: file.path, anchor, ...(document.color ? { color: document.color } : {}) });
        nodeIds.add(id); owner = id;
        appendEdge({ id: `contains:${document.id}:${anchor}`, source: document.id, target: id, type: 'contains', note: '来自当前 Markdown 的规则章节。', origin: {kind:'section',path:file.path} }, file.path);
        if (sectionGroup) appendEdge({ id: `contains:${sectionGroup}:${id}`, source: sectionGroup, target: id, type: 'contains', note: '来自这个章节单独设置的设计分类。', origin: {kind:'classification',path:file.path} }, file.path);
      }
      if (child.type !== 'table') continue;
      const headers = child.children[0]?.children.map(cell => plain(cell).trim()) ?? [];
      const required = ['关系 ID', '类型', '目标身份', '依据'];
      if (!required.every(name => headers.includes(name))) continue;
      for (const row of child.children.slice(1)) {
        const cells = row.children.map(cell => plain(cell).trim());
        const get = (key: string) => cells[headers.indexOf(key)] ?? '';
        const id = identity(get('关系 ID')), type = relationMap[get('类型')];
        const target = get('目标身份').split('/').map(part => part.trim()).join('/');
        if (!id || !type || !target.split('/').every(part => identityPattern.test(part)) || target.split('/').length > 2) { issue(file.path, 'INVALID_RELATION', '关系表中存在无效身份或类型。', 'error', row.position?.start.line); continue; }
        const source = headers.includes('来源身份') ? get('来源身份').split('/').map(part => part.trim()).join('/') : owner;
        if (source !== document.id && !source.startsWith(`${document.id}/`)) { issue(file.path, 'INVALID_RELATION_SOURCE', '文末关系索引的来源必须属于当前文档。'); continue; }
        appendEdge({ id, source, target, type, note: get('依据') || '未补充说明。', origin: {kind:'manual',path:file.path} }, file.path);
      }
    }
  }

  // 总纲声明的系统从总纲展开，避免反向把总纲包含进某个系统而形成归属环。
  if (root) for (const group of groups) {
    const parent = group.parent ?? root.id;
    appendEdge({ id: `contains:${parent}:${group.id}`, source: parent, target: group.id, type: 'contains', note: group.parent ? '来自公开分类的父子层级。' : '游戏总纲统领的顶层分类。', origin: {kind:'catalog',path:projectSystems?'PROJECT.md':root.path} }, root.path);
  }

  // 同一对条目的多次正文提及聚合为引用线；与手工关系独立保留各自来源。
  // 仅阅读界面的同名词提示不进入模型，防止自动补出作者未声明的设计关系。
  for (const item of parsed) {
    const definitions = new Map(item.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]));
    let owner = item.document.id;
    const visit = (node: Nodes) => {
      if (node.type === 'table' && ['关系 ID', '类型', '目标身份', '依据'].every(name => node.children[0]?.children.some(cell => plain(cell).trim() === name))) return;
      if (node.type === 'link' || node.type === 'linkReference') {
        const raw = node.type === 'link' ? node.url : definitions.get(node.identifier.toLowerCase()) ?? '';
        if (raw && !/^[a-z][a-z0-9+.-]*:|^\/|\\/i.test(raw)) try {
          const url = new URL(raw, `https://project.invalid/${item.file.path}`), targetDoc = documents.find(doc => doc.path === decodeURIComponent(url.pathname.slice(1)));
          if (targetDoc && targetDoc.type !== 'guide') {
            const target = targetDoc.id + (url.hash ? `/${decodeURIComponent(url.hash.slice(1))}` : '');
            if (target !== owner && node.position) {
              // 同一端点对的正文引用合并显示，但保留每次出现的位置；手工关系独立存在。
              const id = `reference:${owner}:${target}`;
              const occurrence = { start: item.header.bodyOffset + node.position.start.offset!, end: item.header.bodyOffset + node.position.end.offset!, label: plain(node), url: raw, reference: node.type === 'linkReference' };
              const existing = edges.find(edge => edge.id === id);
              if (existing) { existing.origin!.occurrences!.push(occurrence); existing.note = `正文引用 ${existing.origin!.occurrences!.length} 处。`; }
              else appendEdge({ id, source: owner, target, type: 'references', note: `正文提及「${plain(node)}」，可沿链接阅读原文。`, origin: {kind:'markdown',path:item.file.path,occurrences:[occurrence]} }, item.file.path);
            }
          }
        } catch { /* 无法解析的地址由普通链接诊断处理，不猜测目标。 */ }
      }
      if ('children' in node) node.children.forEach(visit);
    };
    for (const child of item.children) { const anchor = anchorOf(child); if (anchor) owner = `${item.document.id}/${anchor}`; visit(child); }
  }

  // 问题目标是公开语义引用，换模型后仍可从 Markdown 重建关联。
  for (const item of parsed) if (item.document.type === 'question' && Array.isArray(item.header.metadata.targets)) {
    for (const target of item.header.metadata.targets) {
      if (typeof target !== 'string') { issue(item.file.path, 'INVALID_QUESTION_TARGET', '问题目标需要稳定条目 ID。'); continue; }
      appendEdge({ id: `question:${item.document.id}:${target}`, source: item.document.id, target, type: 'references', note: '此问题讨论的设计条目；问题尚未决定时不表示规则已确定。', origin: {kind:'question',path:item.file.path} }, item.file.path);
    }
  }
  // 创作模块关系投影为文档之间的引用；只来源于显式字段，不由布局位置推断。
  const creative = buildCreativeIndex({documents});
  const objectsById = new Map(creative.objects.map(item=>[item.object.id,item]));
  for(const use of creative.references){const source=objectsById.get(use.ownerId),target=objectsById.get(use.targetId);if(!source||!target||source.documentId===target.documentId||!nodeIds.has(source.documentId)||!nodeIds.has(target.documentId))continue;
    const edgeId=`creative:${source.object.id}:${target.object.id}:${contentHash(use.role).slice(0,12)}`;
    if(edges.some(edge=>edge.id===edgeId))continue;
    appendEdge({id:edgeId,source:source.documentId,target:target.documentId,type:'references',note:`模块「${source.object.title}」通过「${use.role}」引用「${target.object.title}」。请在源模块字段中维护。`,origin:{kind:'creative',path:source.path}},source.path);
  }
  // 断链保留为诊断；不把不存在端点交给渲染器，更不制造虚假的目标节点。
  const validEdges = edges.filter(edge => {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) return true;
    issue(nodes.find(node => node.id === edge.source)?.documentPath ?? 'docs/', 'BROKEN_RELATION', `关系 ${edge.id} 的目标 ${edge.target} 不存在。`);
    return false;
  });
  return { documents, diagnostics, groups, nodes, edges: validEdges, ...(root ? { rootDocumentId: root.id } : {}), ...(projectEntry ? { projectEntry: { text: projectEntry.text, hash: projectEntry.hash } } : {}) };
}
