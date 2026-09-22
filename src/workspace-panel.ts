import type { ProjectSnapshot, WorkspaceItem, WorkspaceState } from '../shared/model.ts';
import { projectAction, readWorkspace, updateWorkspace } from './project-client';
import { escapeHtml as html } from './markdown-view';

/** 整理面板仅写工作记录；用户明确发布后才进入公开问题文档。 */
export class WorkspacePanel {
  private dialog = document.createElement('dialog');
  private state: WorkspaceState = { revision: 0, items: [] };
  private selected = '';
  private editingId: string | null = null;
  constructor(private snapshot: () => ProjectSnapshot | undefined, private select: (id: string) => void, private publish: (item: WorkspaceItem) => Promise<void>, private focus: (ids: string[], title: string) => void, private currentView: () => unknown, private restoreView: (view: unknown) => void, private apply: (snapshot: ProjectSnapshot) => void) {
    this.dialog.className = 'project-dialog'; document.body.append(this.dialog);
    this.dialog.addEventListener('click', event => { void this.click(event).catch(error => this.error(error)); });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.save(event).catch(error => this.error(error)); });
  }
  private error(error: unknown) { this.dialog.querySelector('.workspace-feedback')!.textContent = error instanceof Error ? error.message : '整理操作未完成。'; }
  async open(selected = '') { this.editingId = null; const project = this.snapshot(); if (!project) return; this.selected = selected; this.state = await readWorkspace(project.project.id); this.render(); if (!this.dialog.open) this.dialog.showModal(); }
  private render() {
    this.editingId = null;
    const project = this.snapshot()!, nodes = new Map(project.nodes.map(node => [node.id, node]));
    const names = { collection: '分组', annotation: '批注', marker: '标记', view: '保存筛选', proposal: '提案' };
    const items = this.state.items.filter(item => item.kind !== 'proposal').map((item, index) => ({ ...item, order: item.order ?? index * 10 })).sort((a,b) => a.order - b.order);
    this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">MY WORKSPACE</span><h1>整理与批注</h1><p>分组、笔记与标记独立保存，不改动正式策划。</p></div><button class="icon-button" data-work="close" aria-label="关闭整理面板">×</button></header><p class="workspace-feedback" role="status"></p><form class="workbench-form" data-work-form="add"><div class="form-columns"><label>记录类型<select name="kind"><option value="collection">工作分组</option><option value="annotation">批注 / 私人笔记</option><option value="marker">收藏 / 待复核 / 风险</option></select></label><label>可见范围<select name="scope"><option value="personal">个人</option><option value="project">项目</option></select></label></div><label>名称<input name="title" required maxlength="150" placeholder="例如：本轮优先讨论"/></label><label>关联条目<select name="targets" multiple size="5">${project.nodes.map(node => `<option value="${html(node.id)}" ${node.id === this.selected ? 'selected' : ''}>${html(node.title)}</option>`).join('')}</select><small>可多选；同一条目可以加入多个工作分组。</small></label><div class="form-columns"><label>标签<input name="tags" placeholder="以逗号分隔，例如：风险, 待复核"/></label><label>归入分组<select name="parent"><option value="">无</option>${items.filter(item => item.kind === 'collection').map(item => `<option value="${item.id}">${html(item.title)}</option>`).join('')}</select></label></div><label>原文摘录（片段批注可填写）<textarea name="excerpt" rows="2">${html(nodes.get(this.selected)?.summary ?? '')}</textarea></label><label>说明<textarea name="text" rows="3" placeholder="记录关注原因或待讨论内容"></textarea></label><button class="primary-button" type="submit">添加记录</button></form><details><summary>批量归档 / 恢复文档</summary><form class="workbench-form" data-work-form="archive"><label>文档范围<select name="documents" multiple size="5">${project.documents.filter(doc => doc.type !== 'guide').map(doc => `<option value="${doc.id}">${html(doc.title)} · ${doc.status === 'archived' ? '已归档' : '当前'}</option>`).join('')}</select></label><label>操作<select name="action"><option value="archive">归档（保留所有引用，默认隐藏）</option><option value="restore">恢复为草稿</option></select></label><p class="quiet">操作覆盖所选整份文档及其条目；关联关系保留，并产生版本，可从历史恢复。</p><button type="submit" class="secondary-button">确认对所选文档执行</button></form></details><div class="workspace-items">${items.map(item => `<article class="workspace-record"><header><span>${names[item.kind]} · ${item.scope === 'personal' ? '个人' : '项目'}</span><strong>${html(item.title)}</strong><small>${item.state === 'resolved' ? '已处理' : '进行中'}${item.parent ? ` · ${html(items.find(parent => parent.id === item.parent)?.title ?? '原分组已移除')}` : ''}</small></header>${item.excerpt ? `<blockquote>${html(item.excerpt)}</blockquote>` : ''}<p>${html(item.text)}</p><div class="change-chips">${item.tags.map(tag => `<span>${html(tag)}</span>`).join('')}</div><div class="record-targets">${item.targets.map(id => nodes.has(id) ? `<button data-target="${html(id)}">${html(nodes.get(id)!.title)}</button>` : `<span class="quiet">目标已移除 · 原摘录保留</span>`).join('')}</div><div class="record-actions">${item.kind !== 'view' ? `<button data-work="edit" data-id="${item.id}">编辑记录</button>` : ''}<button data-work="up" data-id="${item.id}">上移</button><button data-work="focus" data-id="${item.id}">${item.kind === 'view' ? '恢复阅读视图' : '查看这组条目'}</button><button data-work="resolve" data-id="${item.id}">${item.state === 'resolved' ? '重新打开' : '标为已处理'}</button><button data-work="reply" data-id="${item.id}">补充说明</button>${item.kind === 'annotation' ? `<button data-work="publish" data-id="${item.id}">发布为公开问题…</button>` : ''}<button data-work="remove" data-id="${item.id}">移除记录</button></div><div id="reply-${item.id}"></div></article>`).join('') || '<p class="quiet">还没有整理记录。</p>'}</div>`;
  }
  private async save(event: SubmitEvent) {
    const form = event.target as HTMLFormElement, data = new FormData(form), now = new Date().toISOString();
    if (form.dataset.workForm === 'archive') { if (this.snapshot()!.historical) throw new Error('请回到最新再整理正式文档。'); const ids = data.getAll('documents'); this.apply(await projectAction<ProjectSnapshot>(this.snapshot()!.project.id, 'archive-documents', { documentIds: ids, archived: data.get('action') === 'archive' })); await this.open(); return; }
    const item: WorkspaceItem = { id: `work-${crypto.randomUUID()}`, kind: data.get('kind') as WorkspaceItem['kind'], title: String(data.get('title')).trim(), scope: data.get('scope') as 'personal' | 'project', targets: data.getAll('targets').map(String), tags: String(data.get('tags')).split(/[,，]/).map(tag => tag.trim()).filter(Boolean), text: String(data.get('text')), excerpt: String(data.get('excerpt')), parent: String(data.get('parent')) || undefined, state: 'open', createdAt: now, updatedAt: now };
    if (this.editingId) { const previous = this.state.items.find(item => item.id === this.editingId)!; item.id = previous.id; item.createdAt = previous.createdAt; item.order = previous.order; item.state = previous.state; }
    this.state = await updateWorkspace(this.snapshot()!.project.id, { baseRevision: this.state.revision, item }); this.render();
    this.editingId = null;
  }
  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.target) { this.dialog.close(); this.select(button.dataset.target); return; }
    if (button.dataset.work === 'close') { this.dialog.close(); return; }
    const item = this.state.items.find(item => item.id === button.dataset.id); if (!item) return;
    const action = button.dataset.work;
    if (action === 'edit') {
      this.editingId = item.id;
      const form = this.dialog.querySelector<HTMLFormElement>('[data-work-form="add"]')!;
      for (const [name, value] of Object.entries({ kind: item.kind, scope: item.scope, title: item.title, tags: item.tags.join(', '), parent: item.parent ?? '', excerpt: item.excerpt ?? '', text: item.text })) (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = value;
      for (const option of (form.elements.namedItem('targets') as HTMLSelectElement).options) option.selected = item.targets.includes(option.value);
      form.querySelector('button')!.textContent = '保存这条记录的修改'; form.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
    }
    if (action === 'up') { const ordered = this.state.items.map((item,index) => ({ ...item, order: item.order ?? index * 10 })).sort((a,b) => a.order - b.order), index = ordered.findIndex(row => row.id === item.id); if (index > 0) this.state = await updateWorkspace(this.snapshot()!.project.id, { baseRevision: this.state.revision, item: { ...item, order: ordered[index - 1].order - .5 } }); this.render(); return; }
    if (action === 'focus') { if (item.kind === 'view') this.restoreView(item.payload); else this.focus(item.targets, item.title); this.dialog.close(); return; }
    if (action === 'reply') { this.dialog.querySelector(`#reply-${item.id}`)!.innerHTML = `<label class="workbench-form">补充说明<textarea id="reply-text-${item.id}" rows="3"></textarea></label><button class="secondary-button" data-work="save-reply" data-id="${item.id}">保存补充</button>`; return; }
    if (action === 'publish') { this.dialog.querySelector(`#reply-${item.id}`)!.innerHTML = `<p>发布后，标题、说明及摘录会进入公开 questions 目录，可由 LLM 读取。</p><button class="primary-button" data-work="confirm-publish" data-id="${item.id}">确认发布这条批注</button>`; return; }
    if (action === 'confirm-publish') { await this.publish(item); this.dialog.close(); return; }
    if (action === 'remove') this.state = await updateWorkspace(this.snapshot()!.project.id, { baseRevision: this.state.revision, remove: item.id });
    if (action === 'resolve') this.state = await updateWorkspace(this.snapshot()!.project.id, { baseRevision: this.state.revision, item: { ...item, state: item.state === 'resolved' ? 'open' : 'resolved' } });
    if (action === 'save-reply') { const text = (this.dialog.querySelector(`#reply-text-${item.id}`) as HTMLTextAreaElement).value.trim(); if (!text) return; this.state = await updateWorkspace(this.snapshot()!.project.id, { baseRevision: this.state.revision, item: { ...item, text: `${item.text}\n\n${new Date().toLocaleString()}：${text}` } }); }
    this.render();
  }

  /** 保存筛选只记工作台状态，不把用户分组和镜头当成设计变更。 */
  async saveCurrentView() {
    const snapshot = this.snapshot(); if (!snapshot) return;
    const state = await readWorkspace(snapshot.project.id), now = new Date().toISOString();
    await updateWorkspace(snapshot.project.id, { baseRevision: state.revision, item: { id: `view-${crypto.randomUUID()}`, kind: 'view', title: `阅读视图 ${new Date().toLocaleString()}`, scope: 'personal', targets: [], text: '保存当前搜索、分组和查看方式。', tags: [], state: 'saved', payload: this.currentView(), createdAt: now, updatedAt: now } });
    await this.open();
  }
}
