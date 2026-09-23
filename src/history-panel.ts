import type { CommitRequest, ProjectSnapshot, RevisionManifest } from '../shared/model.ts';
import { openCollaboration } from './prompt-panel';
import { compareSnapshots, lineDiff } from '../shared/compare.ts';
import { projectAction, commitProject, projectHistory, readProject, readRevision, restorePlan, saveBaseline, recoverProject } from './project-client';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** 版本条属于整个工作台，因此文档、卡片与图谱总是查看同一份历史。 */
export class HistoryPanel {
  private element = document.createElement('section');
  private dialog = document.createElement('dialog');
  private entries: RevisionManifest[] = [];
  private sequence = 0;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private projectId = '';
  private planned?: CommitRequest;
  constructor(private current: () => ProjectSnapshot | undefined, private show: (snapshot: ProjectSnapshot) => void) {
    this.element.className = 'version-bar'; this.element.hidden = true;
    document.querySelector('.work-area')!.before(this.element);
    this.dialog.className = 'project-dialog editor-dialog'; document.body.append(this.dialog);
    this.element.addEventListener('click', event => { void this.click(event).catch(error => this.error(error)); });
    this.element.addEventListener('change', event => { const input = event.target as HTMLSelectElement; if (input.id === 'version-select') { this.stop(); void this.select(input.value).catch(error => this.error(error)); } });
    this.dialog.addEventListener('click', event => { void this.click(event).catch(error => this.error(error)); });
  }
  private error(error: unknown) { const message = error instanceof Error ? error.message : '版本操作未完成。'; this.element.querySelector('.version-message')!.textContent = message; const box = this.dialog.querySelector('.version-feedback'); if (box) box.textContent = message; this.stop(); }
  stop() { this.playing = false; clearTimeout(this.timer); const button = this.element.querySelector('[data-history="play"]'); if (button) button.textContent = '播放演进'; }
  sync(snapshot: ProjectSnapshot) { if (snapshot.project.id !== this.projectId) { this.stop(); this.sequence++; this.projectId = snapshot.project.id; this.entries = []; this.element.hidden = true; this.dialog.close(); } if (!this.element.hidden) this.render(); }
  async open() {
    const snapshot = this.current(); if (!snapshot) return;
    this.projectId = snapshot.project.id;
    const entries = await projectHistory(this.projectId);
    this.entries = entries.filter(entry => entry.valid).map(entry => entry.manifest);
    this.element.hidden = false; this.render();
    const bytes = this.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
    this.element.querySelector('.version-message')!.textContent += ` 历史 ${this.entries.length} 版 · 已登记快照 ${(bytes / 1048576).toFixed(2)} MB。`;
    const invalid = entries.filter(entry => !entry.valid);
    if (invalid.length) this.element.querySelector('.version-message')!.textContent = invalid.map(entry => `${entry.manifest.label}：${entry.problem}`).join('；');
  }
  /** 条目与文档历史从同一公开修订链筛选，没有第二份私有历史。 */
  async itemHistory(id: string, document: boolean) {
    await this.open(); this.stop(); this.shell(document ? '文档迭代记录' : '条目迭代记录', '<p>正在核对各版本中这个身份的变化…</p>');
    let previous: ProjectSnapshot | undefined; const rows: string[] = [];
    for (const entry of this.entries) {
      const snapshot = await readRevision(this.projectId, entry.id);
      const exists = document ? snapshot.documents.some(doc => doc.id === id) : snapshot.nodes.some(node => node.id === id);
      const changes = previous ? compareSnapshots(previous, snapshot) : null;
      const changed = !previous ? exists : (document ? changes!.documents : changes!.nodes).some(change => change.id === id) || (!document && changes!.relations.some(change => { const edge = [...snapshot.edges, ...previous!.edges].find(edge => edge.id === change.id); return edge?.source === id || edge?.target === id; }));
      if (changed) rows.push(`<article class="history-row"><strong>${entry.label}</strong><p>${escape(entry.reason)}</p><button class="secondary-button" data-history="read-item-version" data-revision="${entry.id}">阅读这一版</button><button class="secondary-button" data-history="compare-item-version" data-revision="${entry.id}">查看真实差异</button></article>`);
      previous = snapshot;
    }
    this.shell(document ? '文档迭代记录' : '条目迭代记录', rows.join('') || '<p>当前版本链中没有该身份的改动记录。</p>');
  }
  private async baselineManager() {
    const records = await projectAction<{ id: string; name: string; revision: string; canceled: boolean }[]>(this.projectId, 'baseline');
    this.shell('命名基线', `<label class="workbench-form">当前版本的基线名称<input id="baseline-name" maxlength="100" placeholder="例如：首次评审版"/></label><button class="primary-button" data-history="save-baseline">保存基线</button><h2>已有基线</h2>${records.map(record => `<div class="workbench-form"><input aria-label="基线 ${escape(record.name)}" data-baseline-name="${record.id}" value="${escape(record.name)}"/><span>${record.canceled ? '已取消，记录保留' : this.entries.find(entry => entry.id === record.revision)?.label ?? record.revision}</span><div><button data-history="read-item-version" data-revision="${record.revision}">查看版本</button><button data-history="rename-baseline" data-id="${record.id}" data-revision="${record.revision}">改名</button><button data-history="cancel-baseline" data-id="${record.id}" data-revision="${record.revision}">取消基线</button></div></div>`).join('') || '<p>还没有基线。</p>'}`);
  }
  private render() {
    const snapshot = this.current(); if (!snapshot) return;
    const selected = snapshot.historical ? snapshot.revision : 'current';
    this.element.innerHTML = `<div class="version-controls"><button data-history="handoff">交接开场白</button><span class="version-status">${snapshot.historical ? `${escape(snapshot.revisionLabel ?? '')} · 历史只读` : '当前工作稿'}</span><button data-history="previous" aria-label="上一版本">‹</button><label class="sr-only" for="version-select">查看策划版本</label><select id="version-select"><option value="current">当前工作稿</option>${this.entries.map(entry => `<option value="${entry.id}" ${selected === entry.id ? 'selected' : ''}>${entry.label} · ${escape(entry.reason)}</option>`).join('')}</select><button data-history="next" aria-label="下一版本">›</button><button data-history="play">${this.playing ? '暂停' : '播放演进'}</button><button data-history="compare">比较版本</button><button data-history="baseline">命名基线</button>${snapshot.historical ? '<button data-history="restore">恢复此版…</button><button data-history="undo">撤销此批次…</button><button data-history="latest">回到最新</button>' : '<button data-history="refresh">刷新历史</button>'}${snapshot.recoveryRequired ? '<button data-history="recovery">处理未完成提交</button>' : ''}<button data-history="close" aria-label="收起版本条">×</button></div><p class="version-message">${snapshot.historical ? '所见图谱、文档与附件来自同一历史快照。' : '每次正式保存留存完整文档，草稿单独保留。'}</p>`;
  }
  private async select(revision: string) {
    const sequence = ++this.sequence, id = this.projectId, previous = this.current();
    const snapshot = revision === 'current' ? await readProject(id) : await readRevision(id, revision);
    if (sequence !== this.sequence || id !== this.projectId) return;
    this.show(snapshot); this.render();
    if (previous) { const diff = compareSnapshots(previous, snapshot); this.element.querySelector('.version-message')!.textContent = `${diff.documents.length} 份文档变化 · ${diff.nodes.length} 项条目变化 · ${diff.relations.length} 项关系变化${diff.structural ? '' : ' · 无图谱结构变化'}`; }
  }
  private shell(title: string, body: string) { this.dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">VERSION HISTORY</span><h1>${escape(title)}</h1></div><button class="icon-button" data-history="dialog-close" aria-label="关闭版本面板">×</button></header><p class="version-feedback" role="status"></p>${body}`; if (!this.dialog.open) this.dialog.showModal(); }
  private async compare() {
    const options = this.entries.map(entry => `<option value="${entry.id}">${entry.label} · ${escape(entry.reason)}</option>`).join('');
    this.shell('比较两个版本', `<div class="compare-pickers"><label>修改前<select id="compare-before">${options}</select></label><label>修改后<select id="compare-after">${options}</select></label><button class="primary-button" data-history="run-compare">查看差异</button></div><div id="comparison-results"></div>`);
    (this.dialog.querySelector('#compare-before') as HTMLSelectElement).value = this.entries[Math.max(0, this.entries.findIndex(entry => entry.id === this.current()?.revision) - 1)]?.id ?? '';
    (this.dialog.querySelector('#compare-after') as HTMLSelectElement).value = this.current()?.revision ?? this.entries.at(-1)?.id ?? '';
    await this.runCompare();
  }
  private async runCompare() {
    const a = (this.dialog.querySelector('#compare-before') as HTMLSelectElement).value, b = (this.dialog.querySelector('#compare-after') as HTMLSelectElement).value;
    if (!a || !b) return;
    const [before, after] = await Promise.all([readRevision(this.projectId, a), readRevision(this.projectId, b)]);
    const diff = compareSnapshots(before, after);
    const oldDocs = new Map(before.documents.map(document => [document.id, document]));
    const newDocs = new Map(after.documents.map(document => [document.id, document]));
    this.dialog.querySelector('#comparison-results')!.innerHTML = `<p class="quiet">${diff.structural ? '包含图谱结构变化。' : '这两版没有图谱结构变化。'}以下为两端净变化。</p><div class="change-chips">${[...diff.nodes, ...diff.relations].map(change => `<span title="${escape(change.detail)}">${change.kind} · ${escape(change.title)}</span>`).join('')}</div>${diff.documents.map(change => `<details class="diff-document"><summary>${change.kind} · ${escape(change.title)}<small>${escape(change.detail)}</small></summary><pre class="line-diff">${lineDiff(oldDocs.get(change.id)?.text ?? '', newDocs.get(change.id)?.text ?? '').map(line => `<span class="diff-${line.kind}">${line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '} ${escape(line.text)}\n</span>`).join('')}</pre></details>`).join('') || '<p>没有文档差异。</p>'}`;
  }
  private async playStep() {
    if (!this.playing) return;
    const index = this.entries.findIndex(entry => entry.id === this.current()?.revision);
    const next = this.entries[index + 1];
    if (!next) { this.stop(); return; }
    await this.select(next.id);
    if (this.playing) this.timer = setTimeout(() => { void this.playStep().catch(error => this.error(error)); }, 1450);
  }
  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history]'); if (!button) return;
    const action = button.dataset.history, snapshot = this.current(); if (!snapshot) return;
    switch (action) {
      case 'handoff': this.stop();await openCollaboration('handoff',this.current());break;
      case 'close': this.stop(); this.element.hidden = true; if (snapshot.historical) await this.select('current'); break;
      case 'dialog-close': this.dialog.close(); break;
      case 'latest': this.stop(); await this.select('current'); break;
      case 'refresh': await this.open(); break;
      case 'previous': case 'next': { this.stop(); const index = this.entries.findIndex(entry => entry.id === snapshot.revision); const entry = this.entries[Math.max(0, Math.min(this.entries.length - 1, index + (action === 'previous' ? -1 : 1)))]; if (entry) await this.select(entry.id); break; }
      case 'play': if (this.playing) this.stop(); else { this.playing = true; if (this.current()?.revision === this.entries.at(-1)?.id) await this.select(this.entries[0].id); this.render(); this.timer = setTimeout(() => { void this.playStep().catch(error => this.error(error)); }, 1100); } break;
      case 'compare': this.stop(); await this.compare(); break;
      case 'run-compare': await this.runCompare(); break;
      case 'read-item-version': this.dialog.close(); this.stop(); await this.select(button.dataset.revision!); break;
      case 'compare-item-version': { this.dialog.close(); await this.select(button.dataset.revision!); await this.compare(); break; }
      case 'baseline': await this.baselineManager(); break;
      case 'rename-baseline': case 'cancel-baseline': { const name = this.dialog.querySelector<HTMLInputElement>(`[data-baseline-name="${button.dataset.id}"]`)!.value; await projectAction(this.projectId, 'baseline', { baselineId: button.dataset.id, revision: button.dataset.revision, name, action: action === 'rename-baseline' ? '改名' : '取消' }); await this.baselineManager(); break; }
      case 'save-baseline': await saveBaseline(this.projectId, snapshot.revision!, (this.dialog.querySelector('#baseline-name') as HTMLInputElement).value); this.dialog.close(); this.element.querySelector('.version-message')!.textContent = '命名基线已保存到 versions/BASELINES.md。'; break;
      case 'undo': { this.stop(); this.planned = await projectAction<CommitRequest>(this.projectId, 'undo-plan', { revision: snapshot.revision }); this.shell('撤销这个批次', `<p>仅反向应用本批次改动，保留后续无关内容；重叠修改会要求手工处理。确认后产生新版本。</p><ul>${this.planned.changes.map(change => `<li>${escape(change.path)}</li>`).join('')}</ul><button class="primary-button" data-history="confirm-restore">确认撤销并创建版本</button>`); break; }
      case 'restore': {
        this.stop(); this.planned = await restorePlan(this.projectId, snapshot.revision!);
        this.shell('恢复前核对', `<p>将当前策划恢复为 ${escape(snapshot.revisionLabel ?? '')}，并生成新的版本。之后的问答和规则可能从当前稿移除，原历史完整保留。未提交草稿仍独立保存。</p><ul>${this.planned.changes.map(change => `<li>${change.text === null ? '移除' : '写入'} ${escape(change.path)}</li>`).join('')}</ul><button class="primary-button" data-history="confirm-restore" ${this.planned.changes.length ? '' : 'disabled'}>确认这些变化，创建恢复版本</button>`); break;
      }
      case 'confirm-restore': if (this.planned) { button.disabled = true; try { this.show(await commitProject(this.planned)); this.planned = undefined; this.dialog.close(); await this.open(); } finally { button.disabled = false; } } break;
      case 'recovery': this.shell('处理未完成提交', '<p>继续完成或撤回都会核对磁盘哈希。遇到新的外部内容会停下并保留双方文件。</p><button class="primary-button" data-history="continue">继续完成</button><button class="secondary-button" data-history="rollback">撤回该批次</button>'); break;
      case 'continue': case 'rollback': this.show(await recoverProject(this.projectId, action)); this.dialog.close(); await this.open(); break;
    }
  }
}
