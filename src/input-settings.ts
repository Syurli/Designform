import { appForm } from './app-dialog';
import { h } from './creative/render';
import './input-settings.css';

/** 应用命令可改键；系统文字编辑键仍由原生输入框和富文本编辑器处理。 */
export const shortcutCatalog = {
  save:['保存当前文档','Ctrl+S'], saveAll:['保存全部','Ctrl+Alt+S'], saveAs:['项目另存为','Ctrl+Shift+S'],
  undo:['撤销','Ctrl+Z'], redo:['重做','Ctrl+Y'], copy:['复制','Ctrl+C'], cut:['剪切','Ctrl+X'], paste:['粘贴','Ctrl+V'], selectAll:['全选','Ctrl+A'],
  delete:['删除所选内容','Delete'], newDocument:['新建文档','Ctrl+N'], newProject:['新建项目','Ctrl+Shift+N'], open:['打开项目','Ctrl+O'],
  close:['关闭当前标签','Ctrl+W'], find:['查找当前页面','Ctrl+F'], findDirectory:['搜索文档目录','Ctrl+Shift+F'], link:['插入文档引用','Ctrl+K'], rename:['重命名','F2'],
  back:['浏览上一页','Alt+ArrowLeft'], forward:['浏览下一页','Alt+ArrowRight'], settings:['快捷键与鼠标设置','Ctrl+,'],
} as const;
export type ShortcutAction=keyof typeof shortcutCatalog;
export interface InputPreferences { shortcuts:Partial<Record<ShortcutAction,string>>; sideButtons:'normal'|'reverse'|'off'; dragThreshold:number; themeMotion:'soft'|'none' }
const defaults=():InputPreferences=>({shortcuts:{},sideButtons:'normal',dragThreshold:6,themeMotion:'soft'});
let preferences=defaults();
try{const saved=JSON.parse(localStorage.getItem('cewen-input-settings')??'{}');preferences={...preferences,...saved,shortcuts:{...saved.shortcuts},dragThreshold:Math.max(3,Math.min(24,Number(saved.dragThreshold)||6))};if(!['normal','reverse','off'].includes(preferences.sideButtons))preferences.sideButtons='normal';if(!['soft','none'].includes(preferences.themeMotion))preferences.themeMotion='soft';}catch{/* 偏好损坏时使用默认按键，不影响项目文件。 */}
export const inputPreferences=()=>preferences;
export const shortcutLabel=(action:ShortcutAction)=>preferences.shortcuts[action]??shortcutCatalog[action][1];
/** 保存为统一键名，Ctrl 在 macOS 上同样接受 Command；避免输入法组合过程触发命令。 */
export function keyChord(event:KeyboardEvent){if(['Control','Meta','Alt','Shift'].includes(event.key))return '';return [event.ctrlKey||event.metaKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',event.key.length===1?event.key.toUpperCase():event.key].filter(Boolean).join('+');}
export function shortcutAction(event:KeyboardEvent):ShortcutAction|undefined {
  if(event.isComposing||event.keyCode===229)return;
  const chord=keyChord(event).toLowerCase();
  return (Object.keys(shortcutCatalog) as ShortcutAction[]).find(action=>shortcutLabel(action).toLowerCase()===chord)??(chord==='ctrl+shift+z'&&shortcutLabel('redo')==='Ctrl+Y'?'redo':undefined);
}
/** 设置保存后立即生效，仅存于本机；不改变项目或用户正文。 */
export async function openInputSettings(){
  const draft:InputPreferences=structuredClone(preferences);
  await appForm('快捷键与鼠标设置',`<p class="quiet">点击按键框后按下新组合键；Backspace 清空绑定。文字输入中的系统剪贴板键始终可用。</p><div class="shortcut-grid">${(Object.entries(shortcutCatalog) as [ShortcutAction,readonly[string,string]][]).map(([id,[label]])=>`<label>${h(label)}<input data-shortcut="${id}" aria-label="${h(label)}快捷键" readonly value="${h(shortcutLabel(id))}"/></label>`).join('')}</div><fieldset class="input-options"><legend>鼠标与显示</legend><label>鼠标侧键<select name="sideButtons"><option value="normal">侧键 1 上一页，侧键 2 下一页</option><option value="reverse">交换上一页与下一页</option><option value="off">关闭侧键导航</option></select></label><label>右键拖动判定距离（像素）<input name="dragThreshold" type="number" min="3" max="24" value="${draft.dragThreshold}"/></label><label>主题切换<select name="themeMotion"><option value="soft">柔和过渡</option><option value="none">立即切换</option></select></label></fieldset><button type="button" data-reset-input>恢复默认设置</button><p class="quiet">列表：Enter 继续编号，Shift+Enter 项内换行，空项 Enter 退出。引用：单击跳转，Alt+单击编辑文字。</p>`,'保存设置',data=>{
    const assigned=new Map<string,string>();for(const [id,value] of Object.entries(draft.shortcuts)){if(!value)continue;const prior=assigned.get(value.toLowerCase());if(prior)throw new Error(`「${shortcutCatalog[prior as ShortcutAction][0]}」与「${shortcutCatalog[id as ShortcutAction][0]}」使用了同一个快捷键。`);assigned.set(value.toLowerCase(),id);}
    preferences={...draft,sideButtons:String(data.get('sideButtons')) as InputPreferences['sideButtons'],themeMotion:String(data.get('themeMotion')) as InputPreferences['themeMotion'],dragThreshold:Number(data.get('dragThreshold'))};
    localStorage.setItem('cewen-input-settings',JSON.stringify(preferences));window.dispatchEvent(new Event('cewen:input-settings-change'));return true;
  },{className:'input-settings-dialog',onReady:dialog=>{
    // 展示全部有效绑定，校验同时覆盖未改动的默认组合键。
    for(const id of Object.keys(shortcutCatalog) as ShortcutAction[])draft.shortcuts[id]=shortcutLabel(id);
    const sync=()=>{dialog.querySelector<HTMLSelectElement>('[name=sideButtons]')!.value=draft.sideButtons;dialog.querySelector<HTMLSelectElement>('[name=themeMotion]')!.value=draft.themeMotion;dialog.querySelector<HTMLInputElement>('[name=dragThreshold]')!.value=String(draft.dragThreshold);dialog.querySelectorAll<HTMLInputElement>('[data-shortcut]').forEach(input=>input.value=draft.shortcuts[input.dataset.shortcut as ShortcutAction]??shortcutCatalog[input.dataset.shortcut as ShortcutAction][1]);};sync();
    dialog.addEventListener('keydown',event=>{const input=(event.target as HTMLElement).closest<HTMLInputElement>('[data-shortcut]');if(!input||event.key==='Tab'||event.key==='Escape'||event.isComposing)return;event.preventDefault();event.stopPropagation();const chord=event.key==='Backspace'?'':keyChord(event);if(chord||event.key==='Backspace'){draft.shortcuts[input.dataset.shortcut as ShortcutAction]=chord;input.value=chord;}});
    dialog.querySelector('[data-reset-input]')!.addEventListener('click',()=>{Object.assign(draft,defaults());sync();for(const id of Object.keys(shortcutCatalog) as ShortcutAction[])draft.shortcuts[id]=shortcutCatalog[id][1];});
  }});
}
/** 普通输入框也接受自定义编辑键；文档富文本自行处理，避免两个输入系统同时执行。 */
export function initializeInputBindings(){
  document.addEventListener('keydown',event=>{
    const input=(event.target as HTMLElement).closest<HTMLElement>('input,textarea,[contenteditable=true]');if(!input||input.closest('.rich-writing')||input.matches('[data-shortcut]')||event.defaultPrevented)return;
    const action=shortcutAction(event);if(!action||!['undo','redo','copy','cut','paste','selectAll','delete'].includes(action)||shortcutLabel(action)===shortcutCatalog[action][1])return;
    event.preventDefault();event.stopImmediatePropagation();
    if(action==='paste'&&!window.cewenDesktop){void navigator.clipboard.readText().then(text=>{if(document.activeElement===input)document.execCommand('insertText',false,text);}).catch(()=>{});return;}
    if(window.cewenDesktop&&action!=='delete')void window.cewenDesktop.command(action as 'copy'|'cut'|'paste'|'selectAll'|'undo'|'redo');else document.execCommand(action==='delete'?'forwardDelete':action);
  },{capture:true});
}
