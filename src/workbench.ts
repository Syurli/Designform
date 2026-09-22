import type { DocumentDraft, ProjectDocument, ProjectSnapshot, WorkspaceItem } from '../shared/model.ts';
import { prepareDirectoryFields } from './edition';
import { readHeader, parseKnowledge } from '../shared/markdown.ts';
import { documentSections, moveSection, setMetadata, setTitle, putRelation, removeRelation, questionDocument } from '../shared/editing.ts';
import { projectMarkdown } from './document-reading';
import { categoryPresets, writingParts, replaceWriting, writingOutlines } from '../shared/authoring.ts';
import { mountCreationComposer, openCollaboration } from './prompt-panel';
import type { KnowledgeGroup, FileChange } from '../shared/model.ts';
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
  private sourceMode = false;
  private setup?: { brief: string; categories: KnowledgeGroup[] };
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
      if (!['document-editor','writing-title'].includes((event.target as HTMLElement).id) || !this.draft) return;
      if (Date.now() - this.undoAt > 700) { this.undoStack.push(this.draft.text); if (this.undoStack.length > 50) this.undoStack.shift(); this.undoAt = Date.now(); }
      this.redoStack = [];
      const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!;
      this.draft.text = this.sourceMode ? editor.value : replaceWriting(this.draft.text, this.dialog.querySelector<HTMLInputElement>('#writing-title')!.value, editor.value); this.dirty = true; cacheDraft(this.draftProject!, this.draft);
      this.preview();
      this.message('正在保留草稿…');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.flushDraft().catch(error => this.error(error)); }, 650);
    });
    this.dialog.addEventListener('change', event => {
      const input = event.target as HTMLSelectElement;
      if (input.id === 'document-picker') void this.edit(input.value).catch(error => this.error(error));
      if (input.id === 'writing-system' && this.draft) { this.draft.text = setMetadata(this.draft.text,{ system: input.value }); this.dirty = true; void this.flushDraft().catch(error=>this.error(error)); }
      if (input.id === 'writing-outline' && this.draft && input.value) {
        const editor=this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!;
        if (writingParts(this.draft.text).body.trim()) { this.message('正文已有内容，未覆盖。可以用标题工具继续添加章节。'); input.value=''; return; }
        this.draft.text=replaceWriting(this.draft.text,writingParts(this.draft.text).title,writingOutlines[input.value].map(title=>`## ${title}\n\n`).join(''));this.syncEditor();this.dirty=true;void this.flushDraft().catch(error=>this.error(error));
      }
    });
    this.dialog.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.draft) { event.preventDefault(); void this.save().catch(error => this.error(error)); }
    });
    // 尚未成功落盘的草稿需要离开提醒；已保存草稿不阻止正常切换页面。
    window.addEventListener('beforeunload', event => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } });
  }

  private shell(title: string, description: string, content: string, wide = false) {
    this.dialog.classList.remove('writing-dialog');
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
  private async close() { if(this.saving)return;await this.flushDraft();this.draft=null; this.dialog.close(); }

  /** 项目中心始终能手工新建，不要求先连接模型或拥有模板。 */
  async projects() {
    await this.flushDraft(); this.draft = null;
    try { this.library = await listProjects(); } catch { this.library = await connectProjects(); }
    this.shell('项目中心', '从设想开始，或继续已有的独立策划文件夹。', `<div id="creation-composer"></div>
      <details class="empty-project-entry"><summary>直接创建空项目 / 打开最近项目</summary><div class="project-center-grid"><section class="workbench-section"><h2>新建空项目</h2>
      <form data-form="create" class="workbench-form"><label>项目名称<input name="name" required maxlength="100" placeholder="我的游戏" autocomplete="off"/></label>
      <label>起点<select name="kind"><option value="blank">空白项目</option><option value="basic">基础 GDD 模板</option></select></label>
      <details><summary>项目保存位置</summary><label>父目录<input name="directory" value="${html(this.library.defaultDirectory)}" required/></label><p class="quiet">会在这里创建新的独立文件夹，不覆盖已有项目。</p></details>
      <button class="primary-button" type="submit">创建项目</button></form>
      <button class="example-button" data-action="example"><strong>体验虚构示例</strong><span>纸上远行 · 学习关系、文档与问询</span></button></section>
      <section class="workbench-section"><h2>最近项目</h2><div class="recent-projects">${this.library.projects.map(project => `<div class="recent-project-row"><button data-project-path="${html(project.path)}"><strong>${html(project.name)}</strong><small>${project.isExample ? '虚构示例 · ' : ''}${html(project.path)}</small></button><div><button data-copy-project="${project.id}">复制为新项目</button><button data-forget-project="${project.id}">移除最近记录</button></div></div>`).join('') || '<p class="quiet">还没有项目，可以先从左侧新建。</p>'}</div>
      <form data-form="open" class="workbench-form open-project-form"><label>打开已有项目目录<input name="path" required placeholder="选择包含 PROJECT.md 的文件夹"/></label><button class="secondary-button" type="submit">打开文件夹</button></form></section></div></details>`, true);
    this.setup=undefined;
    mountCreationComposer(this.dialog.querySelector('#creation-composer')!, setup=>{this.setup=setup;this.shell('为你的游戏建立项目','设想将保留为待细化的创作起点，之后可直接写总纲或 DD。',`<form data-form="create" class="workbench-form"><label>项目名称<input name="name" required maxlength="100" placeholder="我的游戏"/></label><input type="hidden" name="kind" value="blank"/><label>保存父目录<input name="directory" required value="${html(this.library.defaultDirectory)}"/></label><p class="quiet">将在所选位置创建独立文件夹。取消选择不会丢失设想。</p><details><summary>将保存的创作起点</summary><pre class="brief-preview">${html(setup.brief)}</pre></details><button class="primary-button" type="submit">创建并开始写作</button></form>`);});
  }

  /** 读取原始 Markdown；已有未提交草稿显式提示，不直接覆盖磁盘文件。 */
  async edit(documentId?: string) {
    await this.flushDraft();
    const snapshot = this.getSnapshot();
    if (!snapshot) { await this.projects(); return; }
    if (snapshot.historical) throw new Error('当前正在阅读历史版本，请先回到最新再编辑。');
    const document = snapshot.documents.find(item => item.id === documentId) ?? snapshot.documents.find(item => item.type === 'gdd') ?? snapshot.documents.find(item => item.type !== 'guide') ?? snapshot.documents[0];
    if (!document) { await this.newDocument(); return; }
    this.draftProject = snapshot.project.id;
    this.sourceMode=false;
    this.draft = { id: crypto.randomUUID(), documentPath: document.path, baseHash: document.hash, baseText: document.text, text: document.text, updatedAt: new Date().toISOString() };
    this.dirty = false;
    this.undoStack = []; this.redoStack = [];
    const recovered = (await projectDrafts(snapshot.project.id)).find(item => item.purpose !== 'answers' && item.documentPath === document.path && item.text !== document.text);
    this.renderEditor(document, recovered);
  }

  private renderEditor(document: Pick<ProjectDocument, 'title' | 'path'>, recovered?: DocumentDraft) {
    const snapshot = this.getSnapshot()!;
    const parts=writingParts(this.draft!.text), metadata=readHeader(this.draft!.text).metadata;
    const groups=[...snapshot.groups.filter(group=>group.id!=='system-unassigned'),...categoryPresets.filter(group=>!snapshot.groups.some(current=>current.id===group.id))];
    this.shell('写作工作台', '', `
      <div class="editor-actions"><button class="secondary-button" data-action="new-document">＋ 新建</button><button class="secondary-button" data-action="drafts">未完成草稿</button><button class="secondary-button" data-action="collaborate">与 LLM 完善</button><button class="primary-button" data-action="save-document">保存版本 <kbd>Ctrl S</kbd></button></div>
      ${recovered ? `<div class="draft-recovery">发现未提交草稿（${html(new Date(recovered.updatedAt).toLocaleString())}）<button class="secondary-button" data-action="recover-draft">恢复这份草稿</button></div>` : ''}
      <div class="writing-paper"><input id="writing-title" aria-label="文档标题" maxlength="160" placeholder="给这份设计起个名字" value="${html(parts.title)}"/><div class="writing-properties"><span>${metadata.type==='gdd'?'游戏总纲':metadata.type==='question'?'设计问题':'专项设计 DD'}</span><select id="writing-system" aria-label="设计分类"><option value="">暂不分类</option>${groups.map(group=>`<option value="${group.id}" ${metadata.system===group.id?'selected':''}>${html(group.label)}</option>`).join('')}</select><button data-action="categories">管理分类</button><select id="writing-outline" aria-label="可选写作大纲"><option value="">套用大纲…</option>${Object.keys(writingOutlines).map(title=>`<option>${title}</option>`).join('')}</select></div>
      <div class="format-toolbar" role="group" aria-label="正文格式工具"><button data-action="undo">撤销</button><button data-action="redo">重做</button><button data-format="heading">标题</button><button data-format="bold">加粗</button><button data-format="list">列表</button><button data-format="quote">引用</button><button data-format="table">表格</button><label class="asset-upload">图片<input id="asset-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden/></label><button data-action="preview">阅读预览</button><button data-action="source-mode">完整源码</button></div>
      <textarea id="document-editor" class="markdown-editor body-editor" aria-label="策划正文" placeholder="从你想写的第一句话开始……" spellcheck="false">${html(parts.body)}</textarea><div id="editor-preview" class="markdown-preview editor-preview" hidden></div></div>
      <details class="writing-more"><summary>文档信息与更多操作</summary><label>切换文档<select id="document-picker">${this.draft!.baseHash===null?'<option value="">未保存的新稿</option>':''}${snapshot.documents.map(item=>`<option value="${html(item.id)}" ${item.path===document.path?'selected':''}>${html(item.title)}</option>`).join('')}</select></label><p class="editor-file-path">${html(document.path)}</p><div class="prompt-actions"><button data-action="document-settings">标题与状态</button><button data-action="relationships">管理关系</button><button data-action="structure">章节与路径</button><button data-format="rule">知识条目</button></div><label>本次修改说明<input id="commit-reason" placeholder="自动根据文档标题填写" maxlength="200"/></label></details><div id="conflict-details"></div>`, true);
    this.dialog.classList.add('writing-dialog');this.sourceMode=false;
    if (recovered) this.dialog.querySelector('[data-action="recover-draft"]')?.addEventListener('click', () => {
      // 恢复使用新草稿身份，避免修改另一窗口仍在维护的原草稿。
      this.draft = { ...recovered, id: crypto.randomUUID() }; this.dirty = true;
      this.syncEditor();
      this.dialog.querySelector('.draft-recovery')?.remove();
      void this.flushDraft().catch(error => this.error(error));
    });
    this.dialog.querySelector('#asset-input')?.addEventListener('change', event => { void this.attachImage((event.target as HTMLInputElement).files?.[0]).catch(error => this.error(error)); });
  }

  /** 身份和元数据保留原文，默认编辑区只呈现标题与正文。 */
  private syncEditor() {
    if(!this.draft)return;const parts=writingParts(this.draft.text),editor=this.dialog.querySelector<HTMLTextAreaElement>('#document-editor');
    if(editor)editor.value=this.sourceMode?this.draft.text:parts.body;
    const title=this.dialog.querySelector<HTMLInputElement>('#writing-title');if(title){title.value=parts.title;title.hidden=this.sourceMode;}
    const category=this.dialog.querySelector<HTMLSelectElement>('#writing-system');if(category)category.value=String(readHeader(this.draft.text).metadata.system??'');
    editor?.classList.toggle('body-editor',!this.sourceMode);this.preview();
  }

  /** 预览与最终阅读采用同一安全渲染器，图片定位到当前项目附件。 */
  private preview() {
    const pane = this.dialog.querySelector<HTMLElement>('#editor-preview'); if (!pane || pane.hidden || !this.draft) return;
    const snapshot = this.getSnapshot(), document = this.draft && parseKnowledge([{path:this.draft.documentPath,text:this.draft.text,hash:''}]).documents[0];
    if (snapshot && document) pane.innerHTML = projectMarkdown(document, snapshot, this.draft?.assets);
  }

  private async attachImage(file?: File) {
    if (!file || !this.draft) return;
    if (file.size > 3 * 1024 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('请选择 3 MB 以内的 PNG、JPEG、WebP 或 GIF 图片。');
    const snapshot = this.getSnapshot()!, extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1], path = `docs/assets/image-${crypto.randomUUID()}.${extension}`;
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const asset={path,text:btoa(binary),encoding:'base64' as const};
    if(JSON.stringify([...(this.draft.assets??[]),asset]).length>6*1024*1024)throw new Error('草稿图片合计过大，请先保存当前文档。');
    this.draft.assets=[...(this.draft.assets??[]),asset];
    const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!, depth = this.draft.documentPath.split('/').length - 2;
    editor.setRangeText(`\n![${file.name.replace(/[\[\]\r\n]/g, '')}](${'../'.repeat(depth)}assets/${path.split('/').at(-1)})\n`, editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 用户表单仅修改标题和语义元数据，不要求记忆 YAML 字段。 */
  private settings() {
    const snapshot = this.getSnapshot()!, document = parseKnowledge([{ path: this.draft!.documentPath, text: this.draft!.text, hash: this.draft!.baseHash ?? '' }]).documents[0];
    const container = this.dialog.querySelector('#conflict-details')!;
    container.innerHTML = `<form data-form="settings" class="workbench-form"><h2>文档设置</h2><label>标题<input name="title" required value="${html(document.title)}"/></label><div class="form-columns"><label>设计状态<select name="status">${[['draft','草稿'],['confirmed','已确认'],['question','待确认'],['archived','已归档']].map(([id,title]) => `<option value="${id}" ${document.status === id ? 'selected' : ''}>${title}</option>`).join('')}</select></label><label>主要系统<select name="system"><option value="">未归组</option>${snapshot.groups.filter(group => group.id !== 'system-unassigned').map(group => `<option value="${group.id}" ${document.system === group.id ? 'selected' : ''}>${html(group.label)}</option>`).join('')}</select></label></div><p class="quiet">归档保留文档与引用。关联此文档的关系有 ${snapshot.edges.filter(edge => edge.target === document.id || edge.target.startsWith(document.id + '/')).length} 条，默认总览会隐藏归档条目。</p><button class="secondary-button" type="submit">更新草稿，稍后统一保存版本</button></form>`;
    container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private relationships() {
    const snapshot = this.getSnapshot()!, path = this.draft!.documentPath;
    // 未保存的新稿也有稳定身份，关系来源按草稿即时解析。
    const documentNodes = parseKnowledge([{path,text:this.draft!.text,hash:''}]).nodes.filter(node => node.kind !== 'system');
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
  async newDocument(system = '', type: 'dd' | 'gdd' | 'question' = 'dd') {
    await this.flushDraft();
    const snapshot = this.getSnapshot();
    if (!snapshot) { void this.projects(); return; }
    if(snapshot.historical)throw new Error('请先回到最新版本再创建文档。');
    const existing=type==='gdd'?snapshot.documents.find(doc=>doc.type==='gdd'&&doc.status!=='archived'):undefined;if(existing){await this.edit(existing.id);return;}
    const id=`${type}-${crypto.randomUUID()}`,folder=type==='gdd'?'gdd':type==='question'?'questions':'dd';
    const text=`---\nid: ${id}\ntype: ${type}\nstatus: ${type==='question'?'open':'draft'}\n${system&&system!=='system-unassigned'?`system: ${system}\n`:''}---\n\n# \n\n`;
    this.draft={id:crypto.randomUUID(),purpose:'document',documentPath:`docs/${folder}/${id}.md`,baseHash:null,baseText:null,text,updatedAt:new Date().toISOString()};
    this.draftProject=snapshot.project.id;this.dirty=false;this.undoStack=[];this.redoStack=[];this.renderEditor({title:'新文档',path:this.draft.documentPath});this.dialog.querySelector<HTMLInputElement>('#writing-title')?.focus();
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
    // 保存期间锁定整份工作稿，避免异步返回覆盖用户刚改的标题、分类或正文。
    const controls=[...this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')].map(control=>({control,disabled:control.disabled}));
    controls.forEach(({control})=>{control.disabled=true;});
    try {
    await this.flushDraft();
    const draft = { ...this.draft }, snapshot = this.getSnapshot()!;
    const title=writingParts(draft.text).title.trim();if(!title)throw new Error('请先给这份设计起个名字。');
    const reason = this.dialog.querySelector<HTMLInputElement>('#commit-reason')?.value.trim() || `${draft.baseHash===null?'新建':'编辑'}${title}`;
    const editor = this.dialog.querySelector<HTMLTextAreaElement>('#document-editor')!;
    editor.readOnly = true;
    this.message('正在保存文档与版本快照…');
    try {
      const system=String(readHeader(draft.text).metadata.system??''),preset=categoryPresets.find(group=>group.id===system);
      const categoryChanges=preset&&!snapshot.groups.some(group=>group.id===system)?this.categoryChanges([...snapshot.groups.filter(group=>group.id!=='system-unassigned'),preset],snapshot):[];
      const migratingSelf=categoryChanges.some(change=>change.path===draft.documentPath);
      const updated = await commitProject({ projectId: snapshot.project.id, requestId: crypto.randomUUID(), baseRevision: snapshot.revision, reason, actor: 'user', changes: [...categoryChanges.filter(change=>change.path!==draft.documentPath),{ path: draft.documentPath, baseHash: draft.baseHash, text: migratingSelf?setMetadata(draft.text,{systems:undefined}):draft.text },...(draft.assets??[]).map(asset=>({...asset,baseHash:null}))] });
      await deleteDraft(snapshot.project.id, draft.id);
      this.onChange(updated);
      const document = updated.documents.find(item => item.path === draft.documentPath)!;
      this.draft = { id: crypto.randomUUID(), documentPath: document.path, baseHash: document.hash, baseText: document.text, text: document.text, updatedAt: new Date().toISOString() };
      this.dirty = false;
      this.renderEditor(document);
      this.message(updated.revision === snapshot.revision ? '内容未变化，未创建重复版本。' : '已保存到 Markdown，并记录正式版本。');
      this.dialog.querySelector('#conflict-details')?.replaceChildren();
    } catch (error) {
      if (error instanceof ClientError && error.code === 'FILE_CONFLICT') {
        const details = error.details as { path?: string; currentText?: string; currentHash?: string };
        if(details.path && details.path!==draft.documentPath)throw new Error(`分类或相关文件刚刚发生变化（${details.path}）。草稿已保留，请关闭后刷新项目并恢复草稿再保存。`);
        const container = this.dialog.querySelector<HTMLElement>('#conflict-details')!;
        container.innerHTML = `<section class="conflict-panel"><h2>文件已被修改，先比较再保存</h2><p>上方保留你的草稿。下方是磁盘当前稿和你开始编辑时的原稿；合并需要的内容后，使用新的磁盘版本作为保存基准。</p><div class="conflict-columns"><label>磁盘当前稿<textarea readonly aria-label="磁盘当前稿">${html(details.currentText ?? '文件已删除')}</textarea></label><label>编辑前原稿<textarea readonly aria-label="编辑前原稿">${html(draft.baseText ?? '')}</textarea></label></div><button class="secondary-button" id="accept-conflict-base">我已比较，保留上方合并稿并更新保存基准</button></section>`;
        container.querySelector('#accept-conflict-base')!.addEventListener('click', () => { if (this.draft) { this.draft.baseHash = details.currentHash ?? null; this.draft.baseText = details.currentText ?? null; this.dirty = true; container.replaceChildren(); this.message('保存基准已更新。请核对上方合并稿，再点击保存版本。'); } });
      }
      throw error;
    } finally { editor.readOnly = false; }
    } finally { this.saving = false;controls.forEach(({control,disabled})=>{control.disabled=disabled;}); }
  }

  /** 分类拥有公开的单一来源；升级仅写当前文件，旧快照原样保留。 */
  private categoryChanges(groups: KnowledgeGroup[], snapshot: ProjectSnapshot): FileChange[] {
    if(!snapshot.projectEntry)throw new Error('缺少项目入口，请重新扫描文件后再保存分类。');
    return [{path:'PROJECT.md',baseHash:snapshot.projectEntry.hash,text:setMetadata(snapshot.projectEntry.text,{minimumAppVersion:'0.4.0',systems:groups.map(group=>({id:group.id,title:group.label,color:group.color}))})},...snapshot.documents.filter(doc=>doc.type==='gdd'&&Object.hasOwn(readHeader(doc.text).metadata,'systems')).map(doc=>({path:doc.path,baseHash:doc.hash,text:setMetadata(doc.text,{systems:undefined})}))];
  }

  /** 用户可新增和改名分类，不要求先创建总纲；稳定 ID 不随标题改变。 */
  private rebaseCategoryDraft(before: ProjectSnapshot, after: ProjectSnapshot) {
    if(!this.draft)return;
    const old=before.documents.find(doc=>doc.path===this.draft!.documentPath),updated=after.documents.find(doc=>doc.path===this.draft!.documentPath);
    // 只接续本次分类操作造成的元数据变化；外部修改仍交给原有冲突处理。
    if(old&&updated&&old.hash===this.draft.baseHash&&old.hash!==updated.hash){
      this.draft.text=setMetadata(this.draft.text,{...(readHeader(old.text).metadata.system!==readHeader(updated.text).metadata.system?{system:updated.system}:{}),...(Object.hasOwn(readHeader(old.text).metadata,'systems')?{systems:undefined}:{})});
      this.draft.baseHash=updated.hash;this.draft.baseText=updated.text;this.dirty=true;
    }
  }

  async categories(selected = '') {
    await this.flushDraft();const snapshot=this.getSnapshot();if(!snapshot||snapshot.historical)throw new Error('请在当前项目中管理分类。');
    const content=`<form data-form="category" class="workbench-form"><h2>设计分类</h2><label>已有分类<select name="id"><option value="">新增分类</option>${snapshot.groups.filter(group=>group.id!=='system-unassigned').map(group=>`<option value="${group.id}" ${selected===group.id?'selected':''}>${html(group.label)}</option>`).join('')}</select></label><label>名称<input name="label" required maxlength="80" value="${html(snapshot.groups.find(group=>group.id===selected)?.label??'')}" list="common-categories" placeholder="选择常见类别或输入自定义名称"/><datalist id="common-categories">${categoryPresets.map(group=>`<option>${html(group.label)}</option>`).join('')}</datalist></label><label>分类颜色<input type="color" name="color" value="${snapshot.groups.find(group=>group.id===selected)?.color??'#7CBFFF'}"/></label><button type="submit" class="primary-button">保存分类</button><div class="prompt-actions"><button type="button" data-category-move="-1">分类上移</button><button type="button" data-category-move="1">分类下移</button><button type="button" data-category-remove>删除分类，成员移入未归组</button></div><p class="quiet">只创建分类目录，不生成空 DD。重命名不会改变关联身份。</p></form>`;
    if(this.dialog.open&&this.draft&&this.dialog.querySelector('#conflict-details'))this.dialog.querySelector('#conflict-details')!.innerHTML=content;else{this.draft=null;this.shell('整理设计分类','分类与文档一起保存在公开项目中。',content);}
    this.dialog.querySelector<HTMLSelectElement>('[data-form="category"] select')!.addEventListener('change',event=>{const group=snapshot.groups.find(group=>group.id===(event.target as HTMLSelectElement).value);const form=this.dialog.querySelector<HTMLFormElement>('[data-form="category"]')!;(form.elements.namedItem('label') as HTMLInputElement).value=group?.label??'';(form.elements.namedItem('color') as HTMLInputElement).value=group?.color??'#7CBFFF';});
  }

  /** 新稿尚未出现在正式文档目录，单独的恢复入口避免重启后无处可找。 */
  private async drafts() {
    await this.flushDraft();const snapshot=this.getSnapshot()!;const drafts=(await projectDrafts(snapshot.project.id)).filter(draft=>draft.purpose!=='answers');
    this.draft=null;this.shell('未完成草稿','这些内容尚未全部保存为正式版本。',drafts.map(draft=>`<article class="draft-recovery"><span>${html(writingParts(draft.text).title||'未命名新稿')} · ${html(new Date(draft.updatedAt).toLocaleString())}</span><button class="secondary-button" data-resume-draft="${draft.id}">继续写作</button><button class="secondary-button" data-discard-draft="${draft.id}">删除草稿</button></article>`).join('')||'<p>没有未完成草稿。</p>');
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-resume-draft]').forEach(button=>button.addEventListener('click',()=>{const draft=drafts.find(item=>item.id===button.dataset.resumeDraft)!;this.draft={...draft};this.draftProject=snapshot.project.id;this.dirty=false;this.renderEditor({title:writingParts(draft.text).title,path:draft.documentPath});}));
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-discard-draft]').forEach(button=>button.addEventListener('click',()=>{if(!confirm('删除这份未提交草稿？已保存的正式文档不受影响。'))return;void deleteDraft(snapshot.project.id,button.dataset.discardDraft!).then(()=>this.drafts()).catch(error=>this.error(error));}));
  }

  /** 历史入口先使用真实公开快照，后续版本图谱与它共享同一修订来源。 */
  async history() {
    await this.flushDraft(); this.draft = null;
    const snapshot = this.getSnapshot();
    if (!snapshot) { await this.projects(); return; }
    const entries = await projectHistory(snapshot.project.id);
    this.shell('版本记录', '每个完整版本都保存在项目 versions 文件夹，普通编辑器也能阅读。', `<button class="secondary-button" data-action="handoff">准备版本交接开场白</button><div class="history-list">${entries.slice().reverse().map(entry => `<article class="history-row ${entry.valid ? '' : 'invalid'}"><span>${html(entry.manifest.label)}</span><div><strong>${html(entry.manifest.reason ?? '未完成版本')}</strong><p>${entry.valid ? html(new Date(entry.manifest.createdAt).toLocaleString()) : html(entry.problem ?? '需要核对')}</p><small>${html(`versions/${entry.manifest.label}/`)}</small></div><b>${entry.valid ? '完整快照' : '待处理'}</b></article>`).join('') || '<p class="quiet">尚未形成正式版本。</p>'}</div>${snapshot.recoveryRequired ? '<div class="recovery-actions"><p>项目存在未完成写入；只会处理仍匹配原稿或候选稿的文件。</p><button class="secondary-button" data-action="continue-recovery">继续完成批次</button><button class="secondary-button" data-action="rollback-recovery">撤回未完成批次</button></div>' : ''}`);
  }

  private async click(event: MouseEvent) {
    if(this.saving)return;
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#cewen-doc="]');
    if (link) { event.preventDefault(); await this.close(); window.dispatchEvent(new CustomEvent('cewen:read-document', { detail: decodeURIComponent(link.hash.slice('#cewen-doc='.length)) })); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if(button.dataset.categoryMove || button.hasAttribute('data-category-remove')) {
      const form=this.dialog.querySelector<HTMLFormElement>('[data-form="category"]')!,id=(form.elements.namedItem('id') as HTMLSelectElement).value;
      if(!id)return;const snapshot=this.getSnapshot()!,groups=snapshot.groups.filter(group=>group.id!=='system-unassigned'),index=groups.findIndex(group=>group.id===id);
      if(index<0)return;const changes:FileChange[]=[];
      if(button.hasAttribute('data-category-remove')) {
        if(!confirm(`删除“${groups[index].label}”分类？其中的文档会移入“未归组”，正文和历史都会保留。`))return;
        groups.splice(index,1);
        snapshot.documents.filter(doc=>doc.system===id).forEach(doc=>changes.push({path:doc.path,baseHash:doc.hash,text:setMetadata(doc.text,{system:undefined})}));
      } else {
        const next=index+Number(button.dataset.categoryMove);if(next<0||next>=groups.length)return;
        [groups[index],groups[next]]=[groups[next],groups[index]];
      }
      // 分类迁移与受影响文档一起提交，避免出现暂时失效的归属。
      const categoryChanges=this.categoryChanges(groups,snapshot);
      for(const change of changes){const other=categoryChanges.find(item=>item.path===change.path);if(other){other.text=setMetadata(change.text!,{systems:undefined});}else categoryChanges.push(change);}
      const updated=await commitProject({projectId:snapshot.project.id,requestId:crypto.randomUUID(),baseRevision:snapshot.revision,reason:button.hasAttribute('data-category-remove')?'删除分类并移入未归组':'调整设计分类顺序',actor:'user',changes:categoryChanges});
      this.rebaseCategoryDraft(snapshot,updated);this.onChange(updated);await this.categories(button.hasAttribute('data-category-remove')?'':id);return;
    }
    if (button.dataset.reverseRelation) { await this.save(); this.onChange(await projectAction<ProjectSnapshot>(this.getSnapshot()!.project.id, 'reverse-relation', { relationId: button.dataset.reverseRelation })); const docId = this.getSnapshot()!.documents.find(doc => doc.path === this.draft!.documentPath)!.id; await this.edit(docId); this.relationships(); return; }
    if (button.dataset.editRelation) { const edge = this.getSnapshot()!.edges.find(edge => edge.id === button.dataset.editRelation)!; this.relationships(); const form = this.dialog.querySelector<HTMLFormElement>('[data-form="relation"]')!; form.dataset.relationId = edge.id; for (const [name,value] of Object.entries({ source: edge.source, target: edge.target, note: edge.note, type: ({ depends: '依赖', constrains: '约束', relates: '关联', references: '引用', replaces: '替代', contains: '包含' })[edge.type] })) (form.elements.namedItem(name) as HTMLInputElement).value = value; return; }
    if (button.dataset.section !== undefined && this.draft) { this.undoStack.push(this.draft.text); this.draft.text = moveSection(this.draft.text, Number(button.dataset.section), Number(button.dataset.direction)); this.syncEditor(); this.dirty = true; this.structure(); await this.flushDraft(); return; }
    if (button.dataset.forgetProject) { await projectAction(button.dataset.forgetProject, 'forget', {}); if (this.getSnapshot()?.project.id === button.dataset.forgetProject) location.reload(); else await this.projects(); return; }
    if (button.dataset.copyProject) { this.shell('复制为新项目', '复制当前公开文档，使用新项目身份与初始版本；原项目和历史完整保留。', `<form data-form="copy-project" data-project="${button.dataset.copyProject}" class="workbench-form"><label>新项目名称<input name="name" required maxlength="100"/></label><label>保存父目录<input name="directory" required value="${html(this.library.defaultDirectory)}"/></label><button class="primary-button" type="submit">创建独立副本</button></form>`); return; }
    if (button.dataset.removeRelation && this.draft) { this.draft.text = removeRelation(this.draft.text, button.dataset.removeRelation); this.syncEditor(); this.dirty = true; await this.flushDraft(); this.message('关系已从草稿移除，保存版本后正式生效。'); return; }
    if (button.dataset.projectPath) { await this.flushDraft(); this.onChange(await openProject(button.dataset.projectPath)); this.dialog.close(); return; }
    if (button.dataset.format) { this.format(button.dataset.format); return; }
    switch (button.dataset.action) {
      case 'close': await this.close(); break;
      case 'example': button.disabled = true; try { this.onChange(await createProject('纸上远行 · 基础示例', 'example', this.library.defaultDirectory)); this.dialog.close(); } finally { button.disabled = false; } break;
      case 'new-document': await this.flushDraft(); this.draft = null; this.newDocument(); break;
      case 'handoff': await openCollaboration('handoff',this.getSnapshot());break;
      case 'drafts': await this.drafts(); break;
      case 'categories': await this.categories(); break;
      case 'collaborate': await openCollaboration('write',this.getSnapshot(),this.draft?.baseHash ? [String(readHeader(this.draft.text).metadata.id)] : []); break;
      case 'source-mode': this.sourceMode=!this.sourceMode;this.syncEditor();button.textContent=this.sourceMode?'返回正文':'完整源码';break;
      case 'save-document': button.disabled = true; try { await this.save(); } finally { button.disabled = false; } break;
      case 'preview': { const pane = this.dialog.querySelector<HTMLElement>('#editor-preview')!; pane.hidden = !pane.hidden; this.preview(); break; }
      case 'document-settings': this.settings(); break;
      case 'structure': this.structure(); break;
      case 'relationships': this.relationships(); break;
      case 'undo': case 'redo': {
        if (!this.draft) break;
        const source = button.dataset.action === 'undo' ? this.undoStack : this.redoStack, target = button.dataset.action === 'undo' ? this.redoStack : this.undoStack, text = source.pop();
        if (text === undefined) break; target.push(this.draft.text); this.draft.text = text; this.dirty = true; this.syncEditor(); await this.flushDraft(); break;
      }
      case 'continue-recovery': case 'rollback-recovery': this.onChange(await recoverProject(this.getSnapshot()!.project.id, button.dataset.action === 'continue-recovery' ? 'continue' : 'rollback')); await this.history(); break;
    }
  }

  private async submit(event: SubmitEvent) {
    const form = event.target as HTMLFormElement, data = new FormData(form);
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
    try {
      if(form.dataset.form==='category'){
        const snapshot=this.getSnapshot()!,id=String(data.get('id'))||`system-${crypto.randomUUID()}`,label=String(data.get('label')).trim(),color=String(data.get('color'));
        if(snapshot.groups.some(group=>group.id!==id&&group.label===label))throw new Error('已有同名分类，请选择原分类。');
        const groups=snapshot.groups.filter(group=>group.id!=='system-unassigned'),index=groups.findIndex(group=>group.id===id);
        if(index<0)groups.push({id,label,color});else groups[index]={id,label,color};
        const updated=await commitProject({projectId:snapshot.project.id,requestId:crypto.randomUUID(),baseRevision:snapshot.revision,reason:`更新设计分类：${label}`,actor:'user',changes:this.categoryChanges(groups,snapshot)});
        this.rebaseCategoryDraft(snapshot,updated);this.onChange(updated);
        if(this.draft){this.draft.text=setMetadata(this.draft.text,{system:id});this.dirty=true;this.renderEditor({title:writingParts(this.draft.text).title,path:this.draft.documentPath});await this.flushDraft();}else await this.categories(id);return;
      }
      if (form.dataset.form === 'move-document' && this.draft) { await this.save(); const doc = this.getSnapshot()!.documents.find(doc => doc.path === this.draft!.documentPath)!; this.onChange(await projectAction<ProjectSnapshot>(this.getSnapshot()!.project.id, 'move-document', { documentId: doc.id, destination: data.get('destination') })); await this.edit(doc.id); return; }
      if ((form.dataset.form === 'settings' || form.dataset.form === 'relation') && this.draft) {
        this.undoStack.push(this.draft.text); this.redoStack = [];
        if (form.dataset.form === 'settings') {
          this.draft.text = setTitle(setMetadata(this.draft.text, { status: String(data.get('status')), system: String(data.get('system')) }), String(data.get('title')));
        } else {
          const source = parseKnowledge([{path:this.draft.documentPath,text:this.draft.text,hash:''}]).nodes.find(node => node.id === data.get('source'));
          if (!source) throw new Error('请选择有效的来源条目。');
          this.draft.text = putRelation(this.draft.text, source.anchor, { id: form.dataset.relationId ?? `rel-${crypto.randomUUID()}`, target: String(data.get('target')), type: String(data.get('type')), note: String(data.get('note')) });
        }
        this.syncEditor(); this.dirty = true; await this.flushDraft(); this.message('已更新草稿，请核对后保存版本。'); return;
      }
      if (form.dataset.form === 'create') { if(!String(data.get('directory')??'').trim())throw new Error('请先选择项目保存文件夹。');this.onChange(await createProject(String(data.get('name')), data.get('kind') as 'blank' | 'basic', String(data.get('directory')),this.setup));const startWriting=!!this.setup;this.setup=undefined; this.dialog.close();if(startWriting)await this.newDocument(); }
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
