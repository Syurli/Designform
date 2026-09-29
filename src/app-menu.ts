import './app-menu.css';
/** children 将长清单按用途展开；普通命令继续复用同一菜单。 */
export interface AppCommand { label:string; run?:()=>unknown|Promise<unknown>; children?:AppCommand[]; shortcut?:string; disabled?:boolean; reason?:string; separator?:boolean; danger?:boolean }
let closeCurrent:(()=>void)|undefined;
export function showAppMenu(commands:AppCommand[],anchor:HTMLElement,point?:{x:number;y:number},lifecycle?:{onClose?():void}){
  closeCurrent?.();const abort=new AbortController(),prior=document.activeElement as HTMLElement|null,parent=anchor.closest('dialog[open]')??document.body;
  const panels:HTMLElement[]=[];let closed=false;
  const trim=(depth:number)=>{panels.splice(depth).forEach(panel=>panel.remove());panels[depth-1]?.querySelectorAll('[aria-expanded]').forEach(button=>button.setAttribute('aria-expanded','false'));};
  const close=()=>{if(closed)return;closed=true;abort.abort();trim(0);closeCurrent=undefined;if(prior?.isConnected)prior.focus({preventScroll:true});else if(anchor.isConnected)anchor.focus({preventScroll:true});lifecycle?.onClose?.();};closeCurrent=close;
  const create=(entries:AppCommand[],depth:number,origin:HTMLElement,at?:{x:number;y:number})=>{
    trim(depth);const panel=document.createElement('div');panel.className='app-command-menu';panel.setAttribute('popover','manual');panel.setAttribute('role','menu');panel.setAttribute('aria-label',depth?'插入分类内容':'操作菜单');panels.push(panel);
    const items:HTMLButtonElement[]=[];
    for(const command of entries){
      if(command.separator){const line=document.createElement('hr');line.setAttribute('role','separator');panel.append(line);}
      const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.tabIndex=-1;button.setAttribute('aria-disabled',String(!!command.disabled));button.classList.toggle('danger',!!command.danger);button.title=command.reason??'';
      const label=document.createElement('span'),shortcut=document.createElement('kbd');label.textContent=command.label;shortcut.textContent=command.children?'›':command.shortcut??'';button.append(label,shortcut);items.push(button);panel.append(button);
      const open=(focus:boolean)=>{if(command.disabled||!command.children)return;create(command.children,depth+1,button);button.setAttribute('aria-expanded','true');if(focus)panels[depth+1]?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});};
      if(command.children){button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.onpointerenter=()=>{if(button.getAttribute('aria-expanded')!=='true')open(false);};}
      else button.onpointerenter=()=>trim(depth+1);
      button.onclick=()=>{if(command.disabled)return;if(command.children){open(true);return;}close();Promise.resolve().then(()=>command.run?.()).catch(error=>window.dispatchEvent(new CustomEvent('cewen:operation-error',{detail:error})));};
      button.addEventListener('keydown',event=>{if(event.key==='ArrowRight'&&command.children){event.preventDefault();open(true);}});
    }
    parent.append(panel);panel.showPopover();const box=origin.getBoundingClientRect();let x=at?.x??(depth?box.right-2:box.left),y=at?.y??(depth?box.top:box.bottom);
    if(depth&&x+panel.offsetWidth>innerWidth-8)x=box.left-panel.offsetWidth+2;
    panel.style.left=Math.max(8,Math.min(x,innerWidth-panel.offsetWidth-8))+'px';panel.style.top=Math.max(8,Math.min(y,innerHeight-panel.offsetHeight-8))+'px';
    panel.addEventListener('keydown',event=>{event.stopPropagation();if(event.isComposing)return;const index=items.indexOf(document.activeElement as HTMLButtonElement);let next=index;
      if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();close();return;}
      if(event.key==='ArrowLeft'&&depth){event.preventDefault();trim(depth);origin.focus({preventScroll:true});return;}
      if(event.key==='ArrowDown')next=(index+1)%items.length;else if(event.key==='ArrowUp')next=(index+items.length-1)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;
      event.preventDefault();items[next]?.focus({preventScroll:true});
    });return panel;
  };
  const root=create(commands,0,anchor,point);
  // 子菜单也属于同一次会话，点击、滚动子菜单不关闭父菜单。
  document.addEventListener('pointerdown',event=>{if(!panels.some(panel=>panel.contains(event.target as Node))){event.stopPropagation();close();}},{capture:true,signal:abort.signal});
  document.addEventListener('scroll',event=>{if(!panels.some(panel=>panel.contains(event.target as Node)))close();},{capture:true,signal:abort.signal});
  window.addEventListener('resize',close,{signal:abort.signal});root.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});return close;
}
