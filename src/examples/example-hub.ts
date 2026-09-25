import type { ProjectSnapshot } from '../../shared/model';
import { buildPreset, presets, presetGroups } from '../../shared/creative/presets';
import { readHeader } from '../../shared/markdown';
import { markdownView } from '../markdown-view';
import { connectProjects, createProject, request } from '../project-client';
import { h } from '../creative/render';
import './example-hub.css';

const basicFiles = import.meta.glob('../../templates/example/docs/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
type HubOptions = { onCreated: (snapshot: ProjectSnapshot) => void; practice?: boolean };

/** 示例目录只读取打包内容；选择、切换和预览均不建立项目或写入文件。 */
export function openExampleHub(options: HubOptions) {
 const dialog = document.createElement('dialog');
 dialog.className = 'project-dialog example-hub';
 let selected = 'basic', documentIndex = 0, busy = false;
 const samples = [{ id: 'basic', title: '纸上远行 · 基础示例', description: '从 GDD、专项设计和问题认识策问。' }, ...presets.filter(p => p.id !== 'blank').map(p => ({ id: p.id, title: p.sample, description: p.description }))];
 dialog.innerHTML = `<header class="project-dialog-header"><div><span class="eyebrow">EXAMPLE LIBRARY</span><h1>浏览示例</h1><p>先阅读，再决定是否创建独立练习副本。浏览本身不会创建项目或文件。</p></div><button type="button" data-close aria-label="关闭示例库">×</button></header><div class="example-hub-layout"><nav class="example-hub-list" aria-label="选择示例">${samples.map(s => `<button type="button" data-sample="${s.id}"><strong>${h(s.title)}</strong><span>${h(s.description)}</span></button>`).join('')}</nav><section class="example-hub-content" data-content></section></div><footer class="example-hub-footer"><p role="status">预设在“新建项目”中选择，只提供工作起点；示例供学习和练习。</p><button type="button" data-create class="primary-button">创建独立练习副本并打开</button></footer>`;
 const content = dialog.querySelector<HTMLElement>('[data-content]')!;
 function render() {
  dialog.querySelectorAll<HTMLButtonElement>('[data-sample]').forEach(b => b.setAttribute('aria-current', String(b.dataset.sample === selected)));
  if (selected === 'basic') {
   const documents = Object.entries(basicFiles).filter(([path]) => !path.endsWith('/INDEX.md') && !path.endsWith('/README.md')).map(([path, text]) => ({ title: String(readHeader(text).metadata.title || path.split('/').at(-1)?.replace('.md', '')), text, group: path.includes('/gdd/') ? '游戏总纲' : path.includes('/dd/') ? '专项设计' : '设计问题' }));
   const current = documents[Math.min(documentIndex, documents.length - 1)];
   content.innerHTML = `<h2>纸上远行 · 基础示例</h2><p>学习 GDD、设计分类、文档关系与问询。虚构资料仅在下方阅读。</p><div class="example-hub-docs">${documents.map((d, i) => `<button type="button" data-document="${i}" aria-current="${i === documentIndex}"><small>${h(d.group)}</small>${h(d.title)}</button>`).join('')}</div><article class="example-hub-reading">${current ? markdownView(current.text) : '<p>暂无可预览文档。</p>'}</article>`;
   return;
  }
  const preset = presets.find(p => p.id === selected)!;
  const data = buildPreset(selected, 'example-preview', true);
  const used = new Set<string>(data.documents.map(d => d.group));
  for (const group of [...presetGroups].reverse()) if (used.has(group.key) && 'parent' in group) used.add(group.parent);
  const groups = presetGroups.filter(group => used.has(group.key));
  const current = data.documents[Math.min(documentIndex, data.documents.length - 1)];
  content.innerHTML = `<h2>${h(preset.sample)}</h2><p>${h(preset.description)} 阅读时不会保存演示对象、图片或配音。</p><div class="example-hub-tree">${groups.map(group => `<section class="${'parent' in group ? 'example-hub-child' : ''}"><h3>${h(group.title)}</h3>${data.documents.map((d, i) => d.group === group.key ? `<button type="button" data-document="${i}" aria-current="${i === documentIndex}">${h(d.title)} <small>${d.objects.length} 个对象</small></button>` : '').join('')}</section>`).join('')}</div><article class="example-hub-reading"><h3>${h(current?.title ?? '')}</h3>${current?.body ? markdownView(current.body) : '<p>本页以结构化对象为主，创建练习副本后可查看完整编辑面板。</p>'}${current?.objects.length ? `<h4>包含的对象</h4><ul>${current.objects.map(o => `<li>${h(o.title)} · ${h(o.type)}</li>`).join('')}</ul>` : ''}</article>`;
 }
 dialog.onclick = event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button || busy) return;
  if (button.hasAttribute('data-close')) { dialog.close(); dialog.remove(); return; }
  if (button.dataset.sample) { selected = button.dataset.sample; documentIndex = 0; render(); return; }
  if (button.dataset.document) { documentIndex = Number(button.dataset.document); render(); return; }
  if (button.hasAttribute('data-create')) {
   busy = true; button.disabled = true;
   const status = dialog.querySelector<HTMLElement>('[role=status]')!;
   status.textContent = '正在创建独立练习副本，请勿重复提交。';
   void (async () => {
    const library = await connectProjects();
    if (selected === 'basic') return createProject('纸上远行 · 基础练习', 'example', library.defaultDirectory);
    const preset = presets.find(p => p.id === selected)!;
    return request<ProjectSnapshot>('/api/creative-project', { requestId: crypto.randomUUID(), preset: selected, sample: true, demo: true, name: `${preset.sample} · 练习副本` });
   })().then(snapshot => { dialog.close(); dialog.remove(); options.onCreated(snapshot); }).catch(error => { status.textContent = `创建失败：${error.message}`; }).finally(() => { busy = false; button.disabled = false; });
  }
 };
 dialog.oncancel = event => { if (busy) event.preventDefault(); else dialog.remove(); };
 document.body.append(dialog); render(); dialog.showModal();
}
