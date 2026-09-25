/// <reference types="vite/client" />
/** 发行形态在构建时固定，桌面包不依赖 GitHub Pages 的可用性。 */
export const isWebEdition = import.meta.env.MODE === 'web';
export const releaseUrl = 'https://github.com/Syurli/Designform/releases/latest';

/** 文件夹选择按钮保持在真实用户点击中，避免浏览器拦截延迟弹出的授权框。 */
export function prepareDirectoryFields(container: HTMLElement) {
  const fields = container.querySelectorAll<HTMLInputElement>('input[name="directory"], form[data-form="open"] input[name="path"]');
  for (const input of fields) {
    // 有默认父目录的本机操作复用上次实际选择；取消不改记忆。
    if(!isWebEdition && input.value) {try { input.value=localStorage.getItem('cewen-last-directory')||input.value; }catch { /* 存储受限仍保留服务默认目录。 */ }}
    if (isWebEdition) input.value = ''; input.readOnly = true; input.required = true; input.placeholder = '尚未选择文件夹';
    const details = input.closest('details'); if (details?.querySelector('summary')?.textContent === '项目保存位置') details.open = true;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '选择本机文件夹'; input.after(button);
    // 模块在启动阶段预载，点击时不能先等待 import 才调用选择器。
    button.addEventListener('click', () => {
      if (isWebEdition && !folderPicker) { input.placeholder = '文件服务正在准备，请稍后再点一次'; return; }
      button.disabled = true;
      const selection = isWebEdition ? folderPicker!() : import('./project-client').then(client => client.request<{path: string | null}>('/api/choose-directory', { initial: input.value })).then(result => result.path);
      void selection.then(value => { if (value) { input.value = value; input.title = value; if(!isWebEdition)try {localStorage.setItem('cewen-last-directory',value);}catch {/* 选择结果仍可用于本次操作。 */} input.dispatchEvent(new Event('input',{bubbles:true})); } }).catch(error => { const box = container.querySelector<HTMLElement>('[role="status"]'); if (box && !(error instanceof DOMException && error.name === 'AbortError')) { box.hidden = false; box.textContent = String(error.message ?? error); } }).finally(() => { button.disabled = false; });
    });
  }
  if (!isWebEdition) return;
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-project-path]')) {
    button.addEventListener('click', event => {
      if (!folderPermission || button.dataset.authorized === 'yes') { delete button.dataset.authorized; return; }
      event.stopImmediatePropagation(); event.stopPropagation();
      void folderPermission(button.dataset.projectPath!).then(() => { button.dataset.authorized = 'yes'; button.click(); }).catch(error => {
        const feedback = container.querySelector<HTMLElement>('[role="status"]'); if (feedback) { feedback.hidden = false; feedback.textContent = error.message; }
      });
    });
  }
  if (container.querySelector('[data-form="create"]')) {
    const note = document.createElement('p'); note.className = 'edition-note quiet';
    note.textContent = '网页版 · 正式项目直接保存在你选择的本机文件夹，不上传。浏览示例不会创建项目；明确创建的虚构练习副本暂存在当前浏览器，请及时导出需保留的内容。';
    container.querySelector('.project-dialog-header')?.after(note);
  }
}
let folderPicker: (() => Promise<string>) | undefined;
let folderPermission: ((filename: string) => Promise<void>) | undefined;
if (isWebEdition) void import('../browser/platform').then(platform => {
  folderPicker = platform.chooseDirectory; folderPermission = platform.requestDirectoryPermission;
});
