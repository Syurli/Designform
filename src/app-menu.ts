import './app-menu.css';
export interface AppCommand { label: string; run?: () => unknown | Promise<unknown>; shortcut?: string; disabled?: boolean; reason?: string; separator?: boolean; danger?: boolean }
let closeCurrent: (() => void) | undefined;
/** 菜单位于浏览器顶层；同一命令同时服务于右键、可见按钮与菜单键。 */
export function showAppMenu(commands: AppCommand[], anchor: HTMLElement, point?: { x: number; y: number }) {
  closeCurrent?.();
  const panel = document.createElement('div'); panel.className = 'app-command-menu'; panel.setAttribute('popover','manual'); panel.setAttribute('role','menu');
  const abort = new AbortController(), prior = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => { if (closed) return; closed = true; abort.abort(); panel.remove(); closeCurrent=undefined; if (prior?.isConnected) prior.focus({preventScroll:true}); else if(anchor.isConnected) anchor.focus({preventScroll:true}); };
  closeCurrent=close;
  for (const command of commands) {
    if(command.separator) { const line=document.createElement('hr');line.setAttribute('role','separator');panel.append(line); }
    const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.tabIndex=-1;
    button.setAttribute('aria-disabled',String(!!command.disabled));button.classList.toggle('danger',!!command.danger);button.title=command.reason??'';
    const label=document.createElement('span');label.textContent=command.label;const shortcut=document.createElement('kbd');shortcut.textContent=command.shortcut??'';button.append(label,shortcut);
    button.onclick=()=>{if(command.disabled)return;close();Promise.resolve().then(()=>command.run?.()).catch(error=>window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error})));};panel.append(button);
  }
  (anchor.closest('dialog[open]')??document.body).append(panel);panel.showPopover();
  const box=anchor.getBoundingClientRect(),x=point?.x??box.left,y=point?.y??box.bottom;
  panel.style.left=Math.max(8,Math.min(x,window.innerWidth-panel.offsetWidth-8))+'px';panel.style.top=Math.max(8,Math.min(y,window.innerHeight-panel.offsetHeight-8))+'px';
  const items=Array.from(panel.querySelectorAll<HTMLButtonElement>('button'));
  panel.addEventListener('keydown',event=>{event.stopPropagation();if(event.isComposing)return;const index=items.indexOf(document.activeElement as HTMLButtonElement);let next=index;
    if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();close();return;}
    if(event.key==='ArrowDown')next=(index+1)%items.length;else if(event.key==='ArrowUp')next=(index+items.length-1)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;
    event.preventDefault();items[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{if(!panel.contains(event.target as Node)){event.stopPropagation();close();}},{capture:true,signal:abort.signal});
  document.addEventListener('scroll',event=>{if(!panel.contains(event.target as Node))close();},{capture:true,signal:abort.signal});
  window.addEventListener('resize',close,{signal:abort.signal});items[0]?.focus({preventScroll:true});
  return close;
}
