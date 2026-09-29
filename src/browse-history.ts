import { inputPreferences, shortcutAction } from './input-settings';

/** 浏览历史只记录阅读位置和恢复动作；不保存正文，也不以浏览器后退卸载草稿。 */
type Visit={key:string;restore:()=>void;capture?:()=>void};
const visits:Visit[]=[];let index=-1,scope='',restoring=false,lastSideKey=0;
export function historyScope(project:string){if(scope===project)return;scope=project;visits.length=0;index=-1;changed();}
export function recordVisit(key:string,restore:()=>void,capture?:()=>void){
  if(restoring)return;
  if(visits[index]?.key===key){visits[index]={key,restore,capture};return;}
  visits[index]?.capture?.();visits.splice(index+1);visits.push({key,restore,capture});if(visits.length>120)visits.shift();index=visits.length-1;changed();
}
export function browse(direction:'back'|'forward'){
  if(restoring||document.querySelector('dialog:modal'))return;
  const next=index+(direction==='back'?-1:1);if(next<0||next>=visits.length)return;
  visits[index]?.capture?.();const prior=index;index=next;restoring=true;
  try{visits[index].restore();}catch(error){index=prior;window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error}));}finally{restoring=false;changed();}
}
export const canBrowse=(direction:'back'|'forward')=>direction==='back'?index>0:index>=0&&index<visits.length-1;
function changed(){window.dispatchEvent(new Event('cewen:browse-history-change'));}
/** 同一次物理侧键可能同时产生 DOM 与桌面 app-command，短时间去重防止连续退两页。 */
function side(direction:'back'|'forward'){if(inputPreferences().sideButtons==='off')return;const now=performance.now();if(now-lastSideKey<180)return;lastSideKey=now;browse(inputPreferences().sideButtons==='reverse'?(direction==='back'?'forward':'back'):direction);}
export function initializeBrowseHistory(){
  window.addEventListener('keydown',event=>{if(event.defaultPrevented||event.isComposing||document.querySelector('dialog:modal'))return;const action=shortcutAction(event);if(action==='back'||action==='forward'){event.preventDefault();event.stopImmediatePropagation();browse(action);}},{capture:true});
  window.addEventListener('pointerdown',event=>{if(event.button!==3&&event.button!==4||inputPreferences().sideButtons==='off')return;event.preventDefault();event.stopImmediatePropagation();side(event.button===3?'back':'forward');},{capture:true});
  window.addEventListener('auxclick',event=>{if((event.button===3||event.button===4)&&inputPreferences().sideButtons!=='off'){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  window.cewenDesktop?.onNavigation?.(side);
}
