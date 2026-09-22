import type { DocumentDraft, ProjectDocument, ProjectSnapshot, WorkspaceItem } from '../shared/model.ts';
import { prepareDirectoryFields } from './edition';
import { readHeader, parseKnowledge } from '../shared/markdown.ts';
import { documentSections, moveSection, setMetadata, setTitle, putRelation, removeRelation, questionDocument } from '../shared/editing.ts';
import { projectMarkdown } from './document-reading';
import { cacheDraft, ClientError, commitProject, connectProjects, createProject, deleteDraft, listProjects, openProject, projectDrafts, projectHistory, recoverProject, saveDraft, projectAction, type ProjectLibrary } from './project-client';

/** 文件名、标题和正文都是用户数据，进入模板前统一转义。 */
function html(value: string) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!)); }

/** 项目与文档操作使用独立对话框，避免拆掉已封板的知识空间。 */
export class ProjectWorkbench {
  private dialog = document.createElement('dialog');
  private library: ProjectLibrary = { projects: [], current: null, defaultDirectory: '' };
  private draft: DocumentDraft | null = null;
  private draftProject: string | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draftWrite: Promise<unknown> = Promise.resolve();
  private saving = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private undoAt = 0;
  private getSnapshot: () => ProjectSnapshot | undefined;
  private onChange: (snapshot: ProjectSnapshot) => void;

  constructor(getSnapshot: () => ProjectSnapshot | undefined, onChange: (snapshot: ProjectSnapshot) => void) {
    this.getSnapshot = getSnapshot; this.onChange = onChange;
    this.dialog.className = 'project-dialog';
    document.body.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); void this.close().catch(error => this.error(error)); });
    this.dialog.addEventListener('click', event => { void this.click(event).catch(error => this.error(error)); });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.submit(event).catch(error => this.error(error)); });
    this.dialog.addEventListener('input', event => {
      if ((event.target as HTMLElement).id !== 'document-editor' || !this.draft) return;
      if (Date.now() - this.undoAt > 700) { this.undoStack.push(this.draft.text); if (this.undoStack.length > 50) this.undoStack.shift(); this.undoAt = Date.now(); }
      this.redoStack = [];
      this.draft.text = (event.target as HTMLTextAreaElement).value; this.dirty = true; cacheDraft(this.draftProject!, this.draft);
      this.preview();
      this.message('正在保留草稿…');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.flushDraft().catch(error => this.error(error)); }, 650);
    });
    this.dialog.addEventListener('change', event => {
      const input = event.target as HTMLSelectElement;
      if (input.id === 'document-picker') void this.edit(input.value).catch(error => this.error(error));
    });
    this.dialog.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.draft) { event.preventDefault(); void this.save().catch(error => this.error(error)); }
    });
    // 尚未成功落盘的草稿需要离开提醒；已保存草稿不阻止正常切换页面。
    window.addEventListener('beforeunload', event => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } });
  }

  private shell(title: string, description: string, content: string, wide = false) {
    this.dialog.classList.toggle('editor-dialog', wide);
    this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">DESIGNFORM WORKSPACE</span><h1>${html(title)}</h1><p>${html(description)}</p></div><button class="icon-button" type="button" data-action="close" aria-label="关闭工作面板">×</button></header><div class="workbench-feedback" id="workbench-feedback" role="status" hidden></div>${content}`;
    prepareDirectoryFields(this.dialog);
    if (!this.dialog.open) this.dialog.showModal();
  }
  private message(message: string, error = false) {
    const box = this.dialog.querySelector<HTMLElement>('#workbench-feedback');
    if (box) { box.hidden = false; box.classList.toggle('error', error); box.textContent = message; }
  }
  private error(error: unknown) { this.message(error instanceof Error ? error.message : '操作尚未完成，内容已保留。', true); }
  private async close() { await this.flushDraft(); this.dialog.close(); }

  /** 项目中心始终能手工新建，不要求先连接模型或拥有模板。 */
  async projects() {
    await this.flushDraft(); this.draft = null;
    try { this.library = await listProjects(); } catch { this.library = await connectProjects(); }
    this.shell('项目中心', '从空白开始，或打开独立的策划文件夹。每个项目都有自己的文档和版本。', `
      <div class="project-center-grid"><section class="workbench-section"><h2>新建项目</h2>
      <form data-form="create" class="workbench-form"><label>项目名称<input name="name" required maxlength="100" placeholder="我的游戏" autocomplete="off"/></label>
      <label>起点<select name="kind"><option value="blank">空白项目</option><option value="basic">基础 GDD 模板</option></select></label>
      <details><summary>项目保存位置</summary><label>父目录<input name="directory" value="${html(this.library.defaultDirectory)}" required/></label><p class="quiet">会在这里创建新的独立文件夹，不覆盖已有项目。</p></details>
      <button class="primary-button" type="submit">创建项目</button></form>
      <button class="example-button" data-action="example"><strong>体验虚构示例</strong><span>纸上远行 · 学习关系、文档与问询</span></button></section>
      <section class="workbench-section"><h2>最近项目</h2><div class="recent-projects">${this.library.projects.map(project => `<div class="recent-project-row"><button data-project-path="${html(project.path)}"><strong>${html(project.name)}</strong><small>${project.isExample ? '虚构示例 · ' : ''}${html(project.path)}</small></button><div><button data-copy-project="${project.id}">复制为新项目</button><button data-forget-project="${project.id}">移除最近记录</button></div></div>`).join('') || '<p class="quiet">还没有项目，可以先从左侧新建。</p>'}</div>
      <form data-form="open" class="workbench-form open-project-form"><label>打开已有项目目录<input name="path" required placeholder="填写包含 PROJECT.md 的文件夹路径"/></label><button class="secondary-button" type="submit">打开文件夹</button></form></section></div>`);
  }

  /** 读取原始 Markdown；已有未提交草稿显式提示，不直接覆盖磁盘文件。 */
  async edit(documentId?: string) {
    await this.flushDraft();
    const snapshot = this.getSnapshot();
    if (!snapshot) { await this.projects(); return; }
    if (snapshot.historical) throw new Error('当前正在阅读历史版本，请先回到最新再编辑。');
    const document = snapshot.documents.find(item => item.id === documentId) ?? snapshot.documents.find(item => item.type === 'gdd') ?? snapshot.documents.find(item => item.type !== 'guide') ?? snapshot.documents[0];
    if (!document) { this.newDocument(); return; }
    this.draftProject = snapshot.project.id;
    this.draft = { id: crypto.randomUUID(), documentPath: document.path, baseHash: document.hash, baseText: document.text, text: document.text, updatedAt: new Date().toISOString() };
    this.dirty = false;
    this.undoStack = []; this.redoStack = [];
    const recovered = (await projectDrafts(snapshot.project.id)).find(item => item.purpose !== 'answers' && item.documentPath === document.path && item.text !== document.text);
    this.renderEditor(document, recovered);
  }

  private renderEditor(document: Pick<ProjectDocument, 'title' | 'path'>, recovered?: DocumentDraft) {
    const snapshot = this.getSnapshot()!;
    this.shell(document.title, '编辑当前 Markdown。草稿自动保留，保存后写入正式文件并建立版本。', `
      <div class="editor-actions"><label>文档<select id="document-picker" aria-label="切换编辑文档">${snapshot.documents.map(item => `<option value="${html(item.id)}" ${item.path === document.path ? 'selected' : ''}>${html(item.title)}</option>`).join('')}</select></label><button class="secondary-button" data-action="new-document">新建文档</button><button class="primary-button" data-action="save-document">保存版本 <kbd>Ctrl S</kbd></button></div>
      ${recovered ? `<div class="draft-recovery">发现未提交草稿（${html(new Date(recovered.updatedAt).toLocaleString())}）<button class="secondary-button" data-action="recover-draft">恢复这份草稿</button></div>` : ''}
      <div class="format-toolbar" role="group" aria-label="Markdown 格式工具"><button data-action="undo">撤销</button><button data-action="redo">重做</button><button data-format="heading">标题</button><button data-format="bold">加粗</button><button data-format="list">列表</button><button data-format="quote">引用</button><button data-format="table">表格</button><button data-format="rule">知识条目</button><button data-action="preview">预览正文</button><button data-action="document-settings">标题与归属</button><button data-action="relationships">管理关系</button><button data-action="structure">章节与路径</button><label class="asset-upload">添加图片<input id="asset-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden/></label></div>
      <label class="editor-file-path" for="document-editor">${html(document.path)}</label>
      <textarea id="document-editor" class="markdown-editor" aria-label="Markdown 正文" spellcheck="false">${html(this.draft!.text)}</textarea><div id="editor-preview" class="markdown-preview editor-preview" hidden></div>
      <div class="editor-bottom"><label>本次修改说明<input id="commit-reason" value="编辑${html(document.title)}" maxlength="200"/></label><span class="quiet">正文与图谱共用同一份文件</span></div><div id="conflict-details"></div>`, true);
    if (recovered) this.dialog.querySelector('[data-action="recover-draft"]')?.addEventListener('click', () => {
      // 恢复使用新草稿身份，避免修改另一窗口仍在维护的原草稿。
      this.draft = { ...recovered, id: crypto.randomUUID() }; this.dirty = true;
      this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!.value = recovered.text;
      this.dialog.querySelector('.draft-recovery')?.remove();
      void this.flushDraft().catch(error => this.error(error));
    });
    this.dialog.querySelector('#asset-input')?.addEventListener('change', event => { void this.attachImage((event.target as HTMLInputElement).files?.[0]).catch(error => this.error(error)); });
  }

  /** 预览与最终阅读采用同一安全渲染器，图片定位到当前项目附件。 */
  private preview() {
    const pane = this.dialog.querySelector<HTMLElement>('#editor-preview'); if (!pane || pane.hidden || !this.draft) return;
    const snapshot = this.getSnapshot(), document = snapshot?.documents.find(doc => doc.path === this.draft!.documentPath);
    if (snapshot && document) pane.innerHTML = projectMarkdown({ ...document, text: this.draft.text }, snapshot);
  }

  private async attachImage(file?: File) {
    if (!file || !this.draft) return;
    if (file.size > 3 * 1024 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('请选择 3 MB 以内的 PNG、JPEG、WebP 或 GIF 图片。');
    const snapshot = this.getSnapshot()!, extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1], path = `docs/assets/image-${crypto.randomUUID()}.${extension}`;
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    this.onChange(await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, reason: `添加附件 ${file.name}`, actor: 'user', changes: [{ path, baseHash: null, text: btoa(binary), encoding: 'base64' }] }));
    const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!, depth = this.draft.documentPath.split('/').length - 2;
    editor.setRangeText(`\n![${file.name.replace(/[\[\]\r\n]/g, '')}](${'../'.repeat(depth)}assets/${path.split('/').at(-1)})\n`, editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 用户表单仅修改标题和语义元数据，不要求记忆 YAML 字段。 */
  private settings() {
    const snapshot = this.getSnapshot()!, document = parseKnowledge([{ path: this.draft!.documentPath, text: this.draft!.text, hash: this.draft!.baseHash ?? '' }]).documents[0];
    const container = this.dialog.querySelector('#conflict-details')!;
    container.innerHTML = `<form data-form="settings" class="workbench-form"><h2>文档设置</h2><label>标题<input name="title" required value="${html(document.title)}"/></label><div class="form-columns"><label>设计状态<select name="status">${[['draft','草稿'],['confirmed','已确认'],['question','待确认'],['archived','已归档']].map(([id,title]) => `<option value="${id}" ${document.status === id ? 'selected' : ''}>${title}</option>`).join('')}</select></label><label>主要系统<select name="system"><option value="">未归组</option>${snapshot.groups.filter(group => group.id !== 'system-unassigned').map(group => `<option value="${group.id}" ${document.system === group.id ? 'selected' : ''}>${html(group.label)}</option>`).join('')}</select></label></div>${document.type === 'gdd' ? '<label>新增系统名称（选填）<input name="newSystem" placeholder="例如：角色成长"/></label>' : ''}<p class="quiet">归档保留文档与引用。关联此文档的关系有 ${snapshot.edges.filter(edge => edge.target === document.id || edge.target.startsWith(document.id + '/')).length} 条，默认总览会隐藏归档条目。</p><button class="secondary-button" type="submit">更新草稿，稍后统一保存版本</button></form>`;
    container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private relationships() {
    const snapshot = this.getSnapshot()!, path = this.draft!.documentPath;
    const documentNodes = snapshot.nodes.filter(node => node.documentPath === path && node.kind !== 'system');
    this.dialog.querySelector('#conflict-details')!.innerHTML = `<form data-form="relation" class="workbench-form"><h2>添加语义关系</h2><div class="form-columns"><label>来源条目<select name="source">${documentNodes.map(node => `<option value="${node.id}">${html(node.title)}</option>`).join('')}</select></label><label>目标条目<input name="target" list="relation-targets" required placeholder="输入标题搜索或填写条目身份"/><datalist id="relation-targets">${snapshot.nodes.map(node => `<option value="${node.id}" label="${html(node.title)}"></option>`).join('')}</datalist></label></div><label>关系类型<select name="type">${['依赖','约束','关联','引用','替代'].map(type => `<option>${type}</option>`).join('')}</select></label><label>关系依据<textarea name="note" required rows="2"></textarea></label><button class="secondary-button" type="submit">加入当前草稿</button></form><h3>当前出向关系</h3>${snapshot.edges.filter(edge => edge.type !== 'contains' && documentNodes.some(node => node.id === edge.source)).map(edge => `<p class="quiet">${html(snapshot.nodes.find(node => node.id === edge.source)?.title ?? '')} → ${html(snapshot.nodes.find(node => node.id === edge.target)?.title ?? '')} ${edge.id.startsWith('reference:') ? '<span>正文引用 · 在正文中修改链接</span>' : `<button class="secondary-button" data-edit-relation="${edge.id}">编辑关系</button><button class="secondary-button" data-reverse-relation="${edge.id}">保存草稿并反转</button><button class="secondary-button" data-remove-relation="${edge.id}">从草稿移除</button>`}</p>`).join('')}`;
  }

  /** 章节移动和路径重命名都通过显式表单，保存前仍有草稿可核对。 */
  private structure() {
    if (!this.draft) return;
    this.dialog.querySelector('#conflict-details')!.innerHTML = `<h2>章节顺序</h2>${documentSections(this.draft.text).map((section,index) => `<p>${html(section.title)} <button class="secondary-button" data-section="${index}" data-direction="-1">上移</button><button class="secondary-button" data-section="${index}" data-direction="1">下移</button></p>`).join('')}<form data-form="move-document" class="workbench-form"><h2>文件位置</h2><label>相对项目的新路径<input name="destination" required value="${html(this.draft.documentPath)}"/></label><small>保存当前草稿后移动文件，同时更新项目内相对链接；文档与条目 ID 保持不变。</small><button class="secondary-button" type="submit">保存草稿并移动</button></form>`;
  }

  async publishAnnotation(item: WorkspaceItem) {
    const snapshot = this.getSnapshot(); if (!snapshot || snapshot.historical) throw new Error('请先回到当前工作稿再发布问题。');
    const id = `question-${item.id}`, path = `docs/questions/${id}.md`;
    if (snapshot.documents.some(document => document.id === id)) throw new Error('这条批注已经发布为问题，请在原问题继续讨论。');
    const targets = [...new Set(item.targets.flatMap(target => snapshot.nodes.some(node => node.id === target) ? [target] : snapshot.nodes.some(node => node.id === target.split('/')[0]) ? [target.split('/')[0]] : []))];
    const text = questionDocument({ id, title: item.title, background: `${item.text}\n\n原文摘录：\n${item.excerpt ?? '无'}\n\n由用户发布的批注：${item.id}\n原关联身份：${item.targets.join('、')}`, targets, options: [], revision: snapshot.revision });
    this.onChange(await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, reason: `发布问题：${item.title}`, actor: 'user', changes: [{ path, baseHash: null, text }] }));
  }

  /** 文档只需标题与归属；稳定 ID 自动生成且不依赖显示编号。 */
  newDocument() {
    const snapshot = this.getSnapshot();
    if (!snapshot) { void this.projects(); return; }
    this.shell('新建文档', '先写清楚一件事，再逐步建立与其他文档的联系。', `<form data-form="new-document" class="workbench-form"><label>文档标题<input name="title" required maxlength="100" placeholder="例如：资源系统"/></label><label>文档类型<select name="type"><option value="dd">专项设计 DD</option><option value="gdd">游戏总纲 GDD</option><option value="question">独立问题</option></select></label><label>主要系统<select name="system"><option value="">暂不归组</option>${snapshot.groups.filter(group => group.id !== 'system-unassigned').map(group => `<option value="${html(group.id)}">${html(group.label)}</option>`).join('')}</select></label><button class="primary-button" type="submit">创建并编辑</button></form>`);
  }

  /** 草稿写入按顺序排队；晚返回的旧请求不能覆盖刚输入的新文字。 */
  private async flushDraft() {
    clearTimeout(this.timer);
    if (!this.dirty || !this.draft || !this.draftProject) { await this.draftWrite; return; }
    const draft = { ...this.draft }, projectId = this.draftProject;
    const write = this.draftWrite.catch(() => {}).then(() => saveDraft(projectId, draft));
    this.draftWrite = write;
    await write;
    if (this.draft?.id === draft.id && this.draft.text === draft.text) { this.dirty = false; this.message('草稿已保存；尚未提交为正式版本。'); }
  }

  /** 保存使用打开时哈希；发生冲突只展示双方，不覆盖磁盘或抛弃输入。 */
  private async save() {
    if (!this.draft || !this.draftProject || this.saving) return;
    this.saving = true;
    try {
    await this.flushDraft();
    const draft = { ...this.draft }, snapshot = this.getSnapshot()!;
    const reason = this.dialog.querySelector<HTMLInputElement>('#commit-reason')?.value.trim() || '编辑策划文档';
    const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!;
    editor.readOnly = true;
    this.message('正在保存文档与版本快照…');
    try {
      const updated = await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, reason, actor: 'user', changes: [{ path: draft.documentPath, baseHash: draft.baseHash, text: draft.text }] });
      await deleteDraft(snapshot.project.id, draft.id);
      this.onChange(updated);
      const document = updated.documents.find(item => item.path === draft.documentPath)!;
      this.draft = { id: crypto.randomUUID(), documentPath: document.path, baseHash: document.hash, baseText: document.text, text: document.text, updatedAt: new Date().toISOString() };
      this.dirty = false;
      this.message(updated.revision === snapshot.revision ? '内容未变化，未创建重复版本。' : '已保存到 Markdown，并记录正式版本。');
      this.dialog.querySelector('#conflict-details')?.replaceChildren();
    } catch (error) {
      if (error instanceof ClientError && error.code === 'FILE_CONFLICT') {
        const details = error.details as { currentText?: string; currentHash?: string };
        const container = this.dialog.querySelector<HTMLElement>('#conflict-details')!;
        container.innerHTML = `<section class="conflict-panel"><h2>文件已被修改，先比较再保存</h2><p>上方保留你的草稿。下方是磁盘当前稿和你开始编辑时的原稿；合并需要的内容后，使用新的磁盘版本作为保存基准。</p><div class="conflict-columns"><label>磁盘当前稿<textarea readonly aria-label="磁盘当前稿">${html(details.currentText ?? '文件已删除')}</textarea></label><label>编辑前原稿<textarea readonly aria-label="编辑前原稿">${html(draft.baseText ?? '')}</textarea></label></div><button class="secondary-button" id="accept-conflict-base">我已比较，保留上方合并稿并更新保存基准</button></section>`;
        container.querySelector('#accept-conflict-base')!.addEventListener('click', () => { if (this.draft) { this.draft.baseHash = details.currentHash ?? null; this.draft.baseText = details.currentText ?? null; this.dirty = true; container.replaceChildren(); this.message('保存基准已更新。请核对上方合并稿，再点击保存版本。'); } });
      }
      throw error;
    } finally { editor.readOnly = false; }
    } finally { this.saving = false; }
  }

  /** 历史入口先使用真实公开快照，后续版本图谱与它共享同一修订来源。 */
  async history() {
    await this.flushDraft(); this.draft = null;
    const snapshot = this.getSnapshot();
    if (!snapshot) { await this.projects(); return; }
    const entries = await projectHistory(snapshot.project.id);
    this.shell('版本记录', '每个完整版本都保存在项目 versions 文件夹，普通编辑器也能阅读。', `<div class="history-list">${entries.slice().reverse().map(entry => `<article class="history-row ${entry.valid ? '' : 'invalid'}"><span>${html(entry.manifest.label)}</span><div><strong>${html(entry.manifest.reason ?? '未完成版本')}</strong><p>${entry.valid ? html(new Date(entry.manifest.createdAt).toLocaleString()) : html(entry.problem ?? '需要核对')}</p><small>${html(`versions/${entry.manifest.label}/`)}</small></div><b>${entry.valid ? '完整快照' : '待处理'}</b></article>`).join('') || '<p class="quiet">尚未形成正式版本。</p>'}</div>${snapshot.recoveryRequired ? '<div class="recovery-actions"><p>项目存在未完成写入；只会处理仍匹配原稿或候选稿的文件。</p><button class="secondary-button" data-action="continue-recovery">继续完成批次</button><button class="secondary-button" data-action="rollback-recovery">撤回未完成批次</button></div>' : ''}`);
  }

  private async click(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#cewen-doc="]');
    if (link) { event.preventDefault(); await this.close(); window.dispatchEvent(new CustomEvent('cewen:read-document', { detail: decodeURIComponent(link.hash.slice('#cewen-doc='.length)) })); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.reverseRelation) { await this.save(); this.onChange(await projectAction<ProjectSnapshot>(this.getSnapshot()!.project.id, 'reverse-relation', { relationId: button.dataset.reverseRelation })); const docId = this.getSnapshot()!.documents.find(doc => doc.path === this.draft!.documentPath)!.id; await this.edit(docId); this.relationships(); return; }
    if (button.dataset.editRelation) { const edge = this.getSnapshot()!.edges.find(edge => edge.id === button.dataset.editRelation)!; this.relationships(); const form = this.dialog.querySelector<HTMLFormElement>('[data-form="relation"]')!; form.dataset.relationId = edge.id; for (const [name,value] of Object.entries({ source: edge.source, target: edge.target, note: edge.note, type: ({ depends: '依赖', constrains: '约束', relates: '关联', references: '引用', replaces: '替代', contains: '包含' })[edge.type] })) (form.elements.namedItem(name) as HTMLInputElement).value = value; return; }
    if (button.dataset.section !== undefined && this.draft) { this.undoStack.push(this.draft.text); this.draft.text = moveSection(this.draft.text, Number(button.dataset.section), Number(button.dataset.direction)); this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!.value = this.draft.text; this.dirty = true; this.structure(); this.preview(); await this.flushDraft(); return; }
    if (button.dataset.forgetProject) { await projectAction(button.dataset.forgetProject, 'forget', {}); if (this.getSnapshot()?.project.id === button.dataset.forgetProject) location.reload(); else await this.projects(); return; }
    if (button.dataset.copyProject) { this.shell('复制为新项目', '复制当前公开文档，使用新项目身份与初始版本；原项目和历史完整保留。', `<form data-form="copy-project" data-project="${button.dataset.copyProject}" class="workbench-form"><label>新项目名称<input name="name" required maxlength="100"/></label><label>保存父目录<input name="directory" required value="${html(this.library.defaultDirectory)}"/></label><button class="primary-button" type="submit">创建独立副本</button></form>`); return; }
    if (button.dataset.removeRelation && this.draft) { this.draft.text = removeRelation(this.draft.text, button.dataset.removeRelation); this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!.value = this.draft.text; this.dirty = true; await this.flushDraft(); this.message('关系已从草稿移除，保存版本后正式生效。'); return; }
    if (button.dataset.projectPath) { await this.flushDraft(); this.onChange(await openProject(button.dataset.projectPath)); this.dialog.close(); return; }
    if (button.dataset.format) { this.format(button.dataset.format); return; }
    switch (button.dataset.action) {
      case 'close': await this.close(); break;
      case 'example': button.disabled = true; try { this.onChange(await createProject('纸上远行 · 基础示例', 'example', this.library.defaultDirectory)); this.dialog.close(); } finally { button.disabled = false; } break;
      case 'new-document': await this.flushDraft(); this.draft = null; this.newDocument(); break;
      case 'save-document': button.disabled = true; try { await this.save(); } finally { button.disabled = false; } break;
      case 'preview': { const pane = this.dialog.querySelector<HTMLElement>('#editor-preview')!; pane.hidden = !pane.hidden; this.preview(); break; }
      case 'document-settings': this.settings(); break;
      case 'structure': this.structure(); break;
      case 'relationships': this.relationships(); break;
      case 'undo': case 'redo': {
        if (!this.draft) break;
        const source = button.dataset.action === 'undo' ? this.undoStack : this.redoStack, target = button.dataset.action === 'undo' ? this.redoStack : this.undoStack, text = source.pop();
        if (text === undefined) break; target.push(this.draft.text); this.draft.text = text; this.dirty = true; this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!.value = text; this.preview(); await this.flushDraft(); break;
      }
      case 'continue-recovery': case 'rollback-recovery': this.onChange(await recoverProject(this.getSnapshot()!.project.id, button.dataset.action === 'continue-recovery' ? 'continue' : 'rollback')); await this.history(); break;
    }
  }

  private async submit(event: SubmitEvent) {
    const form = event.target as HTMLFormElement, data = new FormData(form);
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
    try {
      if (form.dataset.form === 'move-document' && this.draft) { const doc = this.getSnapshot()!.documents.find(doc => doc.path === this.draft!.documentPath)!; await this.save(); this.onChange(await projectAction<ProjectSnapshot>(this.getSnapshot()!.project.id, 'move-document', { documentId: doc.id, destination: data.get('destination') })); await this.edit(doc.id); return; }
      if ((form.dataset.form === 'settings' || form.dataset.form === 'relation') && this.draft) {
        this.undoStack.push(this.draft.text); this.redoStack = [];
        if (form.dataset.form === 'settings') {
          this.draft.text = setTitle(setMetadata(this.draft.text, { status: String(data.get('status')), system: String(data.get('system')) }), String(data.get('title')));
          const newSystem = String(data.get('newSystem') ?? '').trim();
          if (newSystem) { const metadata = readHeader(this.draft.text).metadata; this.draft.text = setMetadata(this.draft.text, { systems: [...(Array.isArray(metadata.systems) ? metadata.systems : []), { id: `system-${crypto.randomUUID()}`, title: newSystem, color: '#A7BDDE' }] }); }
        } else {
          const source = this.getSnapshot()!.nodes.find(node => node.id === data.get('source'));
          if (!source) throw new Error('请选择有效的来源条目。');
          this.draft.text = putRelation(this.draft.text, source.anchor, { id: form.dataset.relationId ?? `rel-${crypto.randomUUID()}`, target: String(data.get('target')), type: String(data.get('type')), note: String(data.get('note')) });
        }
        this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!.value = this.draft.text; this.dirty = true; await this.flushDraft(); this.preview(); this.message('已更新草稿，请核对后保存版本。'); return;
      }
      if (form.dataset.form === 'create') { this.onChange(await createProject(String(data.get('name')), data.get('kind') as 'blank' | 'basic', String(data.get('directory')))); this.dialog.close(); }
      else if (form.dataset.form === 'copy-project') { this.onChange(await projectAction<ProjectSnapshot>(form.dataset.project!, 'copy', { name: data.get('name'), directory: data.get('directory') })); this.dialog.close(); }
      else if (form.dataset.form === 'open') { this.onChange(await openProject(String(data.get('path')))); this.dialog.close(); }
      else if (form.dataset.form === 'new-document') {
        const snapshot = this.getSnapshot()!, title = String(data.get('title')).trim().replace(/[\r\n]+/g, ' '), type = String(data.get('type'));
        const id = `${type}-${crypto.randomUUID()}`, folder = type === 'gdd' ? 'gdd' : type === 'question' ? 'questions' : 'dd';
        const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '未命名文档';
        const documentPath = `docs/${folder}/${type.toUpperCase()}-${id.slice(-6)}_${filename}.md`;
        const text = `---\nid: ${id}\ntype: ${type}\nstatus: ${type === 'question' ? 'open' : 'draft'}\n${data.get('system') ? `system: ${data.get('system')}\n` : ''}---\n\n# ${title}\n\n${type === 'question' ? '## 问题背景\n\n请说明需要讨论的边界。\n\n## 可选方案\n\n- 自定义、暂缓、问题前提不成立。\n\n## 用户原始回答\n\n尚未回答。\n\n## 模型解释\n\n尚未形成。\n\n## 决定记录\n\n尚未采纳。\n\n## 文档落实\n\n待讨论。' : '## 设计目标\n\n请填写这份设计要解决的问题。'}\n`;
        this.onChange(await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, reason: `新建${title}`, actor: 'user', changes: [{ path: documentPath, baseHash: null, text }] }));
        await this.edit(id);
      }
    } finally { submit.disabled = false; }
  }

  /** 工具栏插入普通 Markdown，正文仍能在任意文本编辑器中理解。 */
  private format(action: string) {
    const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor');
    if (!editor || !this.draft) return;
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const insert = ({ heading: `\n## ${selected || '章节标题'}\n`, bold: `**${selected || '重点内容'}**`, list: `\n- ${selected || '列表项'}\n`, quote: `\n> ${selected || '引用内容'}\n`, table: '\n| 项目 | 说明 |\n|---|---|\n| 名称 | 内容 |\n', rule: `\n<a id="rule-${crypto.randomUUID()}"></a>\n\n## 新条目\n\n${selected || '在这里写规则和仍未确定的边界。'}\n` } as Record<string, string>)[action];
    if (!insert) return;
    editor.setRangeText(insert, editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true })); editor.focus();
  }
}
