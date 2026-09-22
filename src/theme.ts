/** 主题是应用偏好，不进入任何游戏的 Markdown 或版本历史。 */
export type Theme = 'dark' | 'light';
export type DesktopCommand = 'browser' | 'hide' | 'quit' | 'reload' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'zoomIn' | 'zoomOut' | 'resetZoom';
declare global {
  interface Window {
    cewenDesktop?: {
      theme(): Promise<Theme>;
      setTheme(theme: Theme): Promise<Theme>;
      command(command: DesktopCommand): Promise<void>;
      onTheme(callback: (theme: Theme) => void): () => void;
    };
  }
}
export function currentTheme(): Theme { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
/** 图谱订阅同一事件，只换材质配色，镜头和正在进行的过渡保持不变。 */
export function applyTheme(theme: Theme, notifyDesktop = true) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try { localStorage.setItem('cewen-theme', theme); } catch { /* 禁止本地存储时主题仍立即生效。 */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#080c18' : '#c7cfd5');
  for (const image of document.querySelectorAll<HTMLImageElement>('[data-brand-icon]')) image.src = `${import.meta.env.BASE_URL}icons/cewen-${theme}.svg`;
  for (const link of document.querySelectorAll<HTMLLinkElement>('[data-theme-icon]')) link.href = `${import.meta.env.BASE_URL}icons/cewen-${theme}.svg`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题');
    button.title = theme === 'dark' ? '切换浅色主题' : '切换深色主题';
    button.setAttribute('aria-pressed', String(theme === 'light'));
    button.innerHTML = theme === 'dark' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/></svg>';
  }
  window.dispatchEvent(new CustomEvent<Theme>('cewen-theme-change', { detail: theme }));
  if (notifyDesktop) void window.cewenDesktop?.setTheme(theme).catch(() => { document.querySelector('[data-theme-toggle]')?.setAttribute('title', '页面主题已切换，桌面外框同步失败，请重试。'); });
}
/** 浏览器保留本地偏好；桌面由主进程统一菜单、标题栏和托盘的主题。 */
export async function initializeTheme() {
  applyTheme(currentTheme(), false);
  document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('[data-theme-toggle]')) applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
  window.addEventListener('storage', event => { if (event.key === 'cewen-theme' && (event.newValue === 'dark' || event.newValue === 'light')) applyTheme(event.newValue); });
  if (!window.cewenDesktop) return;
  document.documentElement.classList.add('desktop-host');
  applyTheme(await window.cewenDesktop.theme(), false);
  window.cewenDesktop.onTheme(theme => applyTheme(theme, false));
}

/** 使用页面菜单让所有下拉面板统一主题；窗口系统按钮仍保留原生行为。 */
export function mountDesktopChrome() {
  if (!window.cewenDesktop) return;
  const bar = document.createElement('header'); bar.className = 'desktop-titlebar';
  bar.innerHTML = `<div class="desktop-titlebar-content"><img data-brand-icon alt="策" src="${import.meta.env.BASE_URL}icons/cewen-${currentTheme()}.svg"/><strong>问 <span>Designform</span></strong><details class="desktop-menu"><summary>策问</summary><div><button data-desktop-command="browser">在浏览器打开</button><button data-desktop-command="hide">收起到系统托盘</button><button data-theme-toggle></button><hr/><button data-desktop-command="quit">退出策问</button></div></details><details class="desktop-menu"><summary>编辑</summary><div>${[['undo','撤销'],['redo','重做'],['cut','剪切'],['copy','复制'],['paste','粘贴'],['selectAll','全选']].map(([command,label]) => `<button data-desktop-command="${command}">${label}</button>`).join('')}</div></details><details class="desktop-menu"><summary>视图</summary><div>${[['reload','重新加载'],['zoomIn','放大'],['zoomOut','缩小'],['resetZoom','恢复显示比例']].map(([command,label]) => `<button data-desktop-command="${command}">${label}</button>`).join('')}</div></details></div>`;
  document.body.prepend(bar);
  bar.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-desktop-command]');
    if (button) { void window.cewenDesktop!.command(button.dataset.desktopCommand as DesktopCommand); bar.querySelectorAll('details').forEach(item => item.open = false); }
  });
  for (const menu of bar.querySelectorAll('details')) menu.addEventListener('toggle', () => { if (menu.open) for (const other of bar.querySelectorAll('details')) if (other !== menu) other.open = false; });
  document.addEventListener('pointerdown', event => { if (!(event.target as HTMLElement).closest('.desktop-menu')) bar.querySelectorAll('details').forEach(menu => menu.open = false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') bar.querySelectorAll('details').forEach(menu => menu.open = false); });
}
