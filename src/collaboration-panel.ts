import type { DocumentDraft, ProjectSnapshot, Proposal, WorkspaceItem } from '../shared/model.ts';
import { prepareDirectoryFields, isWebEdition } from './edition';
import type { ImportPlan } from '../server/exchange.ts';
import { inquiry, questionAvailable } from '../shared/inquiry.ts';
import { lineDiff } from '../shared/compare.ts';
import { cacheDraft, updateWorkspace, projectAction, readWorkspace, projectDrafts, saveDraft, deleteDraft, connectProjects } from './project-client';
import { escapeHtml as html, markdownView } from './markdown-view';

/** 问询、交换与审核围绕同一项目工作；任何模型都可通过公开文件包参与。 */
export class CollaborationPanel {
  private dialog = document.createElement('dialog');
  private plan?: ImportPlan;
  private draft?: DocumentDraft;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private opened?: ProjectSnapshot;
  private pendingWrite: Promise<unknown> = Promise.resolve();
  private requestId = crypto.randomUUID();
  private dirty = false;
  constructor(private current: () => ProjectSnapshot | undefined, private apply: (snapshot: ProjectSnapshot) => void) {
    this.dialog.className = 'project-dialog editor-dialog'; document.body.append(this.dialog);
    this.dialog.addEventListener('click', event => { void this.click(event).catch(error => this.error(error)); });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.submit(event).catch(error => this.error(error)); });
    this.dialog.addEventListener('input', event => {
      // 审核稿改变后必须重新固定候选，禁止把界面新稿误当成上一次已预检的内容。
      if ((event.target as HTMLElement).closest('[data-collab-form="review-import"]')) {
        const apply = this.dialog.querySelector<HTMLButtonElement>('[data-collab="apply-import"]');
        if (apply) { apply.disabled = true; apply.textContent = '候选已修改，请先重新预检'; }
      }
      this.captureAnswers(); clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => { void this.storeAnswers().catch(error => this.error(error)); }, 600);
    });
    window.addEventListener('beforeunload', event => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); void this.close().catch(error => this.error(error)); });
  }
  private error(error: unknown) { const feedback = this.dialog.querySelector('.collaboration-feedback'); if (feedback) feedback.textContent = error instanceof Error ? error.message : '协作操作未完成。'; }
  private shell(title: string, body: string) {
    this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">DESIGN TOGETHER</span><h1>${html(title)}</h1><p>问题、原始回答与最终规则分开记录，正式修改形成版本。</p></div><button class="icon-button" data-collab="close" aria-label="关闭协作面板">×</button></header><nav class="collaboration-tabs"><button data-collab="inquiry">问询</button><button data-collab="exchange">资料交换</button><button data-collab="proposals">修改提案</button></nav><p class="collaboration-feedback" role="status"></p>${body}`;
    prepareDirectoryFields(this.dialog);
    if (isWebEdition && this.dialog.querySelector('[data-collab-form="export"]')) {
      const note = document.createElement('p'); note.className = 'quiet'; note.textContent = '网页自动恢复点保存在本机浏览器专用存储，清除网站数据会删除它们。请定期导出完整备份到磁盘；项目文件夹中的正文与 versions 历史不受清除网站数据影响。'; this.dialog.querySelector('[data-collab-form="export"]')!.before(note);
    }
    if (!this.dialog.open) this.dialog.showModal();
  }
  private async close() { await this.storeAnswers(); this.dialog.close(); }
  async open(page: 'inquiry' | 'exchange' | 'proposals' = 'inquiry') {
    await this.storeAnswers(); this.draft = undefined; this.opened = this.current(); this.requestId = crypto.randomUUID();
    if (!this.opened) return;
    if (this.opened.historical && page === 'exchange') { this.shell('历史只读', '<p>资料交换操作面向当前稿。请关闭面板并回到最新，再导入或发起问询。</p>'); return; }
    if (page === 'exchange') { await this.exchange(); return; }
    if (page === 'proposals') { await this.proposals(); return; }
    const questions = this.opened.documents.filter(document => document.type === 'question' && document.status !== 'archived');
    const readonly = Boolean(this.opened.historical);
    this.shell(readonly ? '历史问询 · 只读' : '问询工作台', `<p class="quiet">可以集中回答一批问题，也可以只回答一个方向，再让 LLM 根据最新文档继续追问。推荐方案不会自动选中。</p><form data-collab-form="answers"><div class="inquiry-list">${questions.map(document => {
      const question = inquiry(document), available = questionAvailable(document, this.opened!.documents), locked = readonly || !available.active;
      return `<article class="inquiry-card" data-question="${html(document.id)}"><span class="eyebrow">${html(question.round)}</span><h2>${html(question.title)}</h2><p class="quiet">${!available.active ? html(available.reason) + ' · ' : ''}${question.multiple ? '多选' : '单选或自定义'} · 状态：${html(({ open: '未决', answered: '已回答', decided: '已落实', 'partially-decided': '部分落实' } as Record<string,string>)[question.status] ?? question.status)}${question.follows ? ` · 延续 ${html(question.follows)}：${html(question.condition)}` : ''}${question.baseRevision && question.baseRevision !== this.opened!.revision ? ' · 发题后文档已有更新，作答前请核对背景。' : ''}</p><div class="markdown-preview">${markdownView(question.background)}</div>${question.options.map((option, index) => `<label class="answer-option"><input ${locked ? 'disabled' : ''} type="${question.multiple ? 'checkbox' : 'radio'}" name="option-${document.id}" value="${index}"/>${html(option)}</label>`).join('')}<label class="answer-custom">自定义回答<textarea name="custom-${document.id}" ${locked ? 'disabled' : ''} rows="3" placeholder="也可以完全用自己的话回答"></textarea></label><label class="answer-action">作答方式<select name="action-${document.id}" ${locked ? 'disabled' : ''}><option value="">本次未作答</option><option value="回答">提交选项 / 自定义回答</option><option value="暂缓">暂缓</option><option value="前提不成立">问题前提不成立</option></select></label><details><summary>之前的回答、解释与决定</summary><div class="markdown-preview">${markdownView(`### 用户原始回答\n\n${question.previous}\n\n### 模型解释\n\n${question.interpretation}\n\n### 决定记录\n\n${question.decision}`)}</div></details></article>`;
    }).join('') || '<p class="quiet">还没有问题。可由 LLM 发布问题文档，或在“资料交换”粘贴一轮问询。</p>'}</div>${questions.length && !readonly ? '<button class="primary-button sticky-submit" type="submit">提交本轮已填写回答</button>' : ''}</form>`);
    if (questions.length && !readonly) {
      const drafts = await projectDrafts(this.opened.project.id);
      const previous = drafts.find(draft => draft.purpose === 'answers' && draft.baseText && (() => { try { const hashes = JSON.parse(draft.baseText); return questions.some(doc => hashes[doc.id] === doc.hash); } catch { return false; } })());
      this.draft = { id: crypto.randomUUID(), purpose: 'answers', documentPath: questions[0].path, baseHash: questions[0].hash, baseText: JSON.stringify(Object.fromEntries(questions.map(doc => [doc.id, doc.hash]))), text: '{}', updatedAt: new Date().toISOString() };
      if (previous) {
        try { const saved = JSON.parse(previous.text) as Record<string, string[]>; for (const input of this.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[name]')) { const values = saved[input.name], questionId = input.name.replace(/^(option|custom|action)-/, ''); if (!values || JSON.parse(previous.baseText!)[questionId] !== questions.find(doc => doc.id === questionId)?.hash) continue; if (input instanceof HTMLInputElement) input.checked = values.includes(input.value); else input.value = values[0] ?? ''; } this.dialog.querySelector('.collaboration-feedback')!.textContent = '已恢复未提交的问询草稿，请核对题目后提交。'; } catch { this.error(new Error('旧问询草稿无法解析，原文件已保留。')); }
      }
    }
  }
  /** 输入即保留浏览器应急副本，稍后顺序写入项目草稿。 */
  private captureAnswers() {
    const form = this.dialog.querySelector<HTMLFormElement>('[data-collab-form="answers"]');
    if (!this.draft || !this.opened || !form) return;
    const data = new FormData(form), saved: Record<string, string[]> = {};
    for (const key of new Set(data.keys())) saved[key] = data.getAll(key).map(String);
    const text = JSON.stringify(saved); if (text !== this.draft.text) this.dirty = true;
    this.draft.text = text; cacheDraft(this.opened.project.id, this.draft);
  }
  private async storeAnswers() {
    clearTimeout(this.draftTimer); this.captureAnswers();
    if (!this.draft || !this.opened || !this.dirty) { await this.pendingWrite; return; }
    const projectId = this.opened.project.id, draft = { ...this.draft };
    this.pendingWrite = this.pendingWrite.catch(() => {}).then(() => saveDraft(projectId, draft)); await this.pendingWrite;
    if (this.draft?.text === draft.text) this.dirty = false;
  }
  private async exchange() {
    const snapshot = this.opened!, library = await connectProjects(), backup = await projectAction<{ records: { directory: string; createdAt: string }[]; error?: string }>(snapshot.project.id, 'backup-status'), work = await readWorkspace(snapshot.project.id);
    this.shell('资料交换', `<div class="exchange-grid"><section><h2>交给 LLM 的上下文</h2><form data-collab-form="context" class="workbench-form"><label>文档范围<select name="documents" multiple size="6">${snapshot.documents.filter(document => document.type !== 'guide').map(document => `<option value="${html(document.id)}">${html(document.title)}</option>`).join('')}</select><small>不选表示全部公开文档；私人笔记默认不包含。</small></label><details><summary>按条目、工作分组或项目批注选择</summary><label>条目范围<select name="nodes" multiple size="4">${snapshot.nodes.filter(node => node.kind !== 'system').map(node => `<option value="${node.id}">${html(node.title)}</option>`).join('')}</select></label><label>工作分组<select name="collections" multiple size="3">${work.items.filter(item => item.kind === 'collection').map(item => `<option value="${item.id}">${html(item.title)}</option>`).join('')}</select></label><label>显式附上项目批注<select name="annotations" multiple size="3">${work.items.filter(item => item.kind === 'annotation' && item.scope === 'project').map(item => `<option value="${item.id}">${html(item.title)}</option>`).join('')}</select></label><small>条目会带上所在完整文档以保持上下文；选择分组只传其成员文档，不传分组笔记。</small></details><button class="secondary-button" type="submit">生成并预览交换包</button></form><div id="context-output"></div><h2>导入已有 Markdown</h2><form data-collab-form="import" class="workbench-form"><label>来源文件夹<input name="directory" required placeholder="只读取你指定的目录"/></label><button class="secondary-button" type="submit">预检与映射</button></form><details><summary>或者粘贴 Markdown / JSON 交换包</summary><form data-collab-form="paste-import" class="workbench-form"><label>内容格式<select name="kind"><option value="markdown">Markdown</option><option value="json">JSON 交换包</option></select></label><label>导入内容<textarea name="text" rows="6" required></textarea></label><button type="submit" class="secondary-button">暂存并预检</button></form></details><div id="import-preview"></div></section><section><h2>导出与备份</h2><p class="quiet">每天首次稳定读取保留完整恢复点，自动轮换最近 7 份（含个人记录，只保存在本机）。${backup.error ? `最近备份未完成：${html(backup.error)}` : backup.records.length ? `最近：${html(new Date(backup.records.at(-1)!.createdAt).toLocaleString())}` : '首份备份正在准备。'}</p><form data-collab-form="export" class="workbench-form"><label>输出父目录<input name="directory" required value="${html(library.defaultDirectory)}"/></label><label>包含范围<select name="mode"><option value="current">当前策划文档</option><option value="history">当前文档与完整历史</option><option value="full">完整项目备份</option></select></label><label class="answer-option"><input name="personal" type="checkbox"/>包含个人笔记与整理记录</label><button class="secondary-button" type="submit">创建独立导出目录</button></form><h2>接收问询 / 提案包</h2><form data-collab-form="receive" class="workbench-form"><label>包类型<select name="kind"><option value="questions">问询包</option><option value="proposal">修改提案</option></select></label><label>JSON 内容<textarea name="content" rows="9" required placeholder='{"round":"ROUND-001","questions":[...]}'></textarea></label><button class="primary-button" type="submit">校验并接收</button></form><p class="quiet">修改提案进入审核区；接收不代表已经采纳。</p></section></div>`);
  }
  private renderImport() {
    const plan = this.plan!;
    this.dialog.querySelector('#import-preview')!.innerHTML = `<ul>${plan.files.map(file => `<li>${html(file.action)} · ${html(file.source)} → ${html(file.destination)}</li>`).join('')}</ul><p class="quiet">${plan.diagnostics.map(issue => html(`${issue.path}：${issue.message}`)).join('<br>') || '预检通过。请核对路径、身份、归属与关系。'}</p><form class="workbench-form" data-collab-form="review-import">${plan.request.changes.filter(change => !change.encoding && change.text !== null).map(change => `<details><summary><label><input name="paths" type="checkbox" value="${html(change.path)}" checked/>${html(change.path)}</label></summary><label>候选 Markdown（可调整身份、归属和关系；来源原文单独保留）<textarea name="edit:${html(change.path)}" rows="8">${html(change.text!)}</textarea></label></details>`).join('')}<button class="secondary-button" type="submit">按勾选与编辑内容重新预检</button></form><button class="primary-button" data-collab="apply-import" ${plan.diagnostics.some(issue => issue.severity === 'error') ? 'disabled' : ''}>确认当前预检候选并应用导入</button><p class="quiet">修改候选后请先重新预检；确认操作只应用最近一次预检的固定内容。</p>`;
  }

  private async proposals() {
    const snapshot = this.opened!, state = await readWorkspace(snapshot.project.id);
    const proposals = state.items.filter(item => item.kind === 'proposal');
    this.shell('修改提案审核', `${snapshot.historical ? '<p>历史阅读中不能采纳提案，请先回到最新。</p>' : ''}${proposals.map(item => {
      const proposal = item.payload as Proposal;
      const outdated = proposal.changes.some(change => (snapshot.files?.[change.path] ?? null) !== (change.path in (item.appliedFiles ?? {}) ? item.appliedFiles![change.path] : change.baseHash)) || Object.entries(proposal.dependencies).some(([path, hash]) => snapshot.files?.[path] !== (item.appliedFiles?.[path] ?? hash));
      return `<form class="proposal-card" data-collab-form="accept" data-proposal="${item.id}"><h2>${html(item.title)}</h2><p>${html(item.text)}</p><p class="quiet">状态：${html(({ pending: '待审核', accepted: '已采纳', 'partially-accepted': '部分采纳', rejected: '已退回' } as Record<string,string>)[item.state] ?? item.state)} · ${outdated ? '基础文档已变化，需模型重新核对' : '基础文件未变化'}</p>${proposal.changes.map(change => `<details class="diff-document"><summary><label><input name="paths" type="checkbox" ${change.path in (item.appliedFiles ?? {}) ? 'disabled' : ''} value="${html(change.path)}"/>${html(change.path)}${change.path in (item.appliedFiles ?? {}) ? ' · 已采纳' : ''}</label></summary><pre class="line-diff">${lineDiff(snapshot.documents.find(document => document.path === change.path)?.text ?? '', change.text ?? '').map(line => `<span class="diff-${line.kind}">${line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '} ${html(line.text)}\n</span>`).join('')}</pre>${change.text !== null && !(change.path in (item.appliedFiles ?? {})) ? `<label class="workbench-form">可编辑候选正文<textarea name="edit:${html(change.path)}" rows="8">${html(change.text)}</textarea></label>` : ''}</details>`).join('')}<p class="quiet">来源问题的决定与逐文档落实记录会同时更新。仅采纳勾选文件；跨文档引用仍须完整，未勾选部分保持待处理。</p><button class="primary-button" type="submit" ${outdated || snapshot.historical || ['accepted','rejected'].includes(item.state) ? 'disabled' : ''}>采纳所选修改并保存版本</button><button type="button" class="secondary-button" data-collab="reject" data-id="${html(item.id)}">${item.state === 'rejected' ? '重新打开提案' : '退回提案'}</button></form>`;
    }).join('') || '<p class="quiet">暂无提案。可通过资料交换或 MCP 接收模型建议。</p>'}`);
  }
  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-collab]'); if (!button) return;
    const action = button.dataset.collab;
    if (action === 'close') await this.close();
    else if (action === 'reject') { const state = await readWorkspace(this.opened!.project.id), item = state.items.find(item => item.id === button.dataset.id)!; await updateWorkspace(this.opened!.project.id, { baseRevision: state.revision, item: { ...item, state: item.state === 'rejected' ? 'pending' : 'rejected' } }); await this.open('proposals'); }
    else if (action === 'inquiry' || action === 'exchange' || action === 'proposals') await this.open(action);
    else if (action === 'apply-import' && this.plan) { this.apply(await projectAction<ProjectSnapshot>(this.opened!.project.id, 'apply-import', { batch: this.plan.id })); await this.open('exchange'); this.dialog.querySelector('.collaboration-feedback')!.textContent = '已提交审核过的导入批次，并保存版本。'; }
    else if (action === 'copy-context') { const text = this.dialog.querySelector<HTMLTextAreaElement>('#context-text')!.value; await navigator.clipboard.writeText(text); this.dialog.querySelector('.collaboration-feedback')!.textContent = '公开交换包已复制，可交给你选择的 LLM。'; }
  }
  private async submit(event: SubmitEvent) {
    const form = event.target as HTMLFormElement, data = new FormData(form), snapshot = this.opened!;
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!; button.disabled = true;
    try {
      switch (form.dataset.collabForm) {
        case 'answers': {
          await this.storeAnswers();
          const answers = snapshot.documents.filter(document => document.type === 'question').flatMap(document => {
            const question = inquiry(document), choices = data.getAll(`option-${document.id}`).map(index => question.options[Number(index)]).filter(Boolean), text = String(data.get(`custom-${document.id}`) ?? ''), action = String(data.get(`action-${document.id}`) || (choices.length || text.trim() ? '回答' : ''));
            return action ? [{ documentId: document.id, baseHash: document.hash, choices, text, action, supersedes: [...question.previous.matchAll(/### 回答 ([A-Za-z0-9_-]+)/g)].at(-1)?.[1] }] : [];
          });
          const updated = await projectAction<ProjectSnapshot>(snapshot.project.id, 'answers', { requestId: this.requestId, answers });
          this.apply(updated); if (this.draft) await deleteDraft(snapshot.project.id, this.draft.id); this.draft = undefined; await this.open('inquiry'); this.dialog.querySelector('.collaboration-feedback')!.textContent = '原始回答已追加到问题 Markdown，并形成版本。'; break;
        }
        case 'context': { const context = await projectAction(snapshot.project.id, 'context', { documents: data.getAll('documents'), nodeIds: data.getAll('nodes'), collectionIds: data.getAll('collections'), annotationIds: data.getAll('annotations') }); const text = JSON.stringify(context, null, 2); this.dialog.querySelector('#context-output')!.innerHTML = `<p class="quiet">${text.length.toLocaleString()} 个字符 · 只含公开文件</p><textarea id="context-text" readonly rows="9" aria-label="LLM 上下文交换包">${html(text)}</textarea><button class="secondary-button" data-collab="copy-context">复制交换包</button>`; break; }
        case 'import': case 'paste-import': { this.plan = await projectAction<ImportPlan>(snapshot.project.id, form.dataset.collabForm === 'import' ? 'import-plan' : 'paste-import', form.dataset.collabForm === 'import' ? { directory: data.get('directory') } : { kind: data.get('kind'), text: data.get('text') }); this.renderImport(); break; }
        case 'review-import': { this.plan = await projectAction<ImportPlan>(snapshot.project.id, 'review-import', { batch: this.plan!.id, paths: data.getAll('paths'), edits: Object.fromEntries([...data].filter(([key]) => key.startsWith('edit:')).map(([key,value]) => [key.slice(5),value])) }); this.renderImport(); this.dialog.querySelector('.collaboration-feedback')!.textContent = '已重新预检筛选及编辑后的候选。请核对后确认应用。'; break; }
        case 'export': { const result = await projectAction<{ directory: string; files: number }>(snapshot.project.id, 'export', { directory: data.get('directory'), mode: data.get('mode'), includePersonal: data.get('personal') === 'on' }); this.dialog.querySelector('.collaboration-feedback')!.textContent = `已导出 ${result.files} 个文件：${result.directory}`; break; }
        case 'receive': { const input = JSON.parse(String(data.get('content'))); const kind = data.get('kind'); const result = await projectAction<ProjectSnapshot | WorkspaceItem>(snapshot.project.id, kind === 'questions' ? 'questions' : 'proposals', { ...input, ...(kind === 'questions' && !input.requestId ? { requestId: this.requestId } : {}) }); if (kind === 'questions') this.apply(result as ProjectSnapshot); await this.open(kind === 'questions' ? 'inquiry' : 'proposals'); break; }
        case 'accept': this.apply(await projectAction<ProjectSnapshot>(snapshot.project.id, 'accept-proposal', { proposalId: form.dataset.proposal, paths: data.getAll('paths'), edits: Object.fromEntries([...data].filter(([key]) => key.startsWith('edit:')).map(([key, value]) => [key.slice(5), value])) })); await this.open('proposals'); break;
      }
    } finally { button.disabled = false; }
  }
}
