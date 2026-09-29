import { showAppMenu } from './app-menu';
/** 主题是应用偏好，不进入任何游戏的 Markdown 或版本历史。 */
import { APP_VERSION } from '../shared/version';
import { inputPreferences } from './input-settings';
export type Theme = 'dark' | 'light';
export type DesktopCommand = 'browser' | 'hide' | 'quit' | 'reload' | 'save' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'zoomIn' | 'zoomOut' | 'resetZoom';
declare global {
  interface Window {
    cewenDesktop?: {
      theme(): Promise<Theme>;
      setTheme(theme: Theme): Promise<Theme>;
      command(command: DesktopCommand): Promise<void>;
      revealDocument(projectId: string, documentId: string): Promise<void>;
      onTheme(callback: (theme: Theme) => void): () => void;
      onNavigation?(callback:(direction:'back'|'forward')=>void):()=>void;
    };
  }
}
export function currentTheme(): Theme { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
/** 图谱订阅同一事件，只换材质配色，镜头和正在进行的过渡保持不变。 */
function commitTheme(theme:Theme,notifyDesktop:boolean){
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try { localStorage.setItem('cewen-theme', theme); } catch { /* 禁止本地存储时主题仍立即生效。 */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171b20' : '#dedfdc');
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
let themeTransition:ViewTransition|undefined;
/** 主题先捕获旧画面再柔和淡出，避免整个窗口在单帧内黑白突变；减少动画偏好立即生效。 */
export function applyTheme(theme:Theme,notifyDesktop=true,animate=true){
  if(theme===currentTheme()||!animate||inputPreferences().themeMotion==='none'||matchMedia('(prefers-reduced-motion: reduce)').matches){commitTheme(theme,notifyDesktop);return;}
  themeTransition?.skipTransition();
  if(document.startViewTransition){themeTransition=document.startViewTransition(()=>commitTheme(theme,notifyDesktop));const active=themeTransition;void active.finished.catch(()=>{}).finally(()=>{if(themeTransition===active)themeTransition=undefined;});}
  else{document.documentElement.classList.add('theme-soft-transition');commitTheme(theme,notifyDesktop);setTimeout(()=>document.documentElement.classList.remove('theme-soft-transition'),320);}
}
/** 浏览器保留本地偏好；桌面由主进程统一菜单、标题栏和托盘的主题。 */
export async function initializeTheme() {
  applyTheme(currentTheme(), false,false);
  document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('[data-theme-toggle]')) applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
  window.addEventListener('storage', event => { if (event.key === 'cewen-theme' && (event.newValue === 'dark' || event.newValue === 'light')) applyTheme(event.newValue); });
  if (!window.cewenDesktop) return;
  document.documentElement.classList.add('desktop-host');
  applyTheme(await window.cewenDesktop.theme(), false,false);
  window.cewenDesktop.onTheme(theme => applyTheme(theme, false));
}

/** 桌面只提供一条可拖动标题栏；应用命令由主工作区统一挂载。 */
export function mountDesktopChrome(){
  if(!window.cewenDesktop)return;
  const bar=document.createElement("header");bar.className="desktop-titlebar";bar.setAttribute("aria-label","应用菜单与窗口拖动区");
  const content=document.createElement("div");content.className="desktop-titlebar-content";bar.append(content);document.body.prepend(bar);
}
let editingFocus:HTMLElement|null=null;
document.addEventListener("focusin",event=>{const target=event.target as HTMLElement;if(!target.closest(".document-menu,.app-command-menu"))editingFocus=target;});
/** 菜单复用当前文档或图谱命令，文本剪贴板仍交给原生控件。 */
export function desktopCommand(command:DesktopCommand){
  if(["save","undo","redo","cut","copy","paste","selectAll"].includes(command)){
    editingFocus?.focus({preventScroll:true});const action=new CustomEvent("cewen:editing-command",{detail:command,cancelable:true});window.dispatchEvent(action);if(action.defaultPrevented||command==="save")return;
  }
  void window.cewenDesktop?.command(command);
}
