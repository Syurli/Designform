import {driver,type Driver} from 'driver.js';
import 'driver.js/dist/driver.css';
import type {TutorialAdapter,TutorialFrame,TutorialStore,TutorialProgress} from './types';
const KEY='cewen-tutorial-progress-v1';
/** Web 存储故障只退回会话记忆，绝不阻塞创作保存。 */
export class WebTutorialStore implements TutorialStore {
 private memory:Record<string,TutorialProgress>={};
 read(){try{const value=JSON.parse(localStorage.getItem(KEY)??'{}');if(value&&typeof value==='object'&&!Array.isArray(value)){const safe:Record<string,TutorialProgress>={};for(const [id,raw] of Object.entries(value)){const p=raw as Partial<TutorialProgress>;if(p&&Number.isInteger(p.version)&&Number.isInteger(p.step)&&['running','paused','completed','skipped','partial'].includes(p.status??''))safe[id]={...p,completed:Array.isArray(p.completed)?p.completed.filter(x=>typeof x==='string'):[],skipped:Array.isArray(p.skipped)?p.skipped.filter(x=>typeof x==='string'):[]} as TutorialProgress;}this.memory=safe;}}catch{}return structuredClone(this.memory);}
 write(values:Record<string,TutorialProgress>){this.memory=structuredClone(values);try{localStorage.setItem(KEY,JSON.stringify(values));}catch{}}
}
export function visibleTarget(target:string){const raw=target.startsWith('dom:')?target.slice(4):target;const el=document.querySelector<HTMLElement>(`[data-tutorial="${CSS.escape(raw)}"]`);if(!el||el.closest('[hidden],[inert]'))return null;const style=getComputedStyle(el),rect=el.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0?el:null;}
async function waitTarget(target:string,signal:AbortSignal){const until=Date.now()+4000;while(!signal.aborted&&Date.now()<until){const el=visibleTarget(target);if(el)return el;await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,60);signal.addEventListener('abort',done,{once:true});});}return null;}
/** 每次只显示已准备好的当前步骤；不依赖 Driver 是否等待异步钩子。 */
export class DriverTutorialAdapter implements TutorialAdapter {
 private instance?:Driver;private clearing=false;private off?:()=>void;private priorFocus?:HTMLElement;private lesson?:HTMLElement;private watcher?:MutationObserver;private target?:HTMLElement;
 canHandle(target?:string){return !target||!target.includes(':')||target.startsWith('dom:');}
 async show(frame:TutorialFrame){this.clear();const {step,controls,signal,definition,index}=frame;const target=step.waitFor??step.target,element=target?await waitTarget(target,signal):null;if(signal.aborted)return;this.priorFocus=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
  const note=target&&!element?'当前目标不可见或尚无对应内容。请先打开所需项目/页面；也可以跳过本步骤。':'';
  const safe=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  if(step.check||element?.closest('dialog[open]')){
   const lesson=document.createElement('aside');this.lesson=lesson;lesson.className='tutorial-practice-panel';lesson.setAttribute('role','region');lesson.setAttribute('aria-label','操作教程');lesson.innerHTML=`<header><strong>${safe(step.title)}</strong><small>${index+1}/${definition.steps.length}</small></header><p>${safe(step.description)}</p><p data-feedback role="status">${safe(note)}</p><div data-buttons></div>`;
   const add=(text:string,callback:()=>void,disabled=false)=>{const button=document.createElement('button');button.type='button';button.textContent=text;button.disabled=disabled;button.onclick=callback;lesson.querySelector('[data-buttons]')!.append(button);};
   add('上一步',controls.previous,index===0);add('跳过本步',controls.skipStep);add('快进',controls.fastForward,index===definition.steps.length-1);add('暂停',controls.pause);add('跳过教程',controls.skipAll);add(index===definition.steps.length-1?'完成':'完成本步',controls.next);
   const attach=()=>{if(signal.aborted)return;const dialogs=Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')),parent=dialogs.at(-1)??document.body;if(lesson.parentElement!==parent)parent.append(lesson);};attach();this.watcher=new MutationObserver(attach);this.watcher.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
   if(element){this.target=element;element.classList.add('tutorial-practice-target');}
   const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();controls.pause();}};document.addEventListener('keydown',key,true);this.off=()=>document.removeEventListener('keydown',key,true);return;
  }
  this.instance=driver({animate:!matchMedia('(prefers-reduced-motion:reduce)').matches,allowClose:true,overlayClickBehavior:'close',allowKeyboardControl:false,popoverClass:'cewen-tutorial-popover',stagePadding:7,stageRadius:8,showButtons:['close'],onDestroyed:()=>{if(!this.clearing)controls.pause();},onPopoverRender:(popover)=>{popover.footer.style.display='flex';popover.progress.textContent=`${index+1} / ${definition.steps.length}`;popover.footerButtons.replaceChildren();
   const button=(text:string,action:()=>void,disabled=false)=>{const b=document.createElement('button');b.type='button';b.className='driver-popover-btn';b.textContent=text;b.disabled=disabled;b.onclick=action;popover.footerButtons.append(b);};
   button('上一步',controls.previous,index===0);button('跳过本步',controls.skipStep);button('暂停',controls.pause);button('快进',controls.fastForward,index===definition.steps.length-1);button('跳过教程',controls.skipAll);button(index===definition.steps.length-1?'完成':'下一步',controls.next,!!note&&!step.optional);
   popover.wrapper.setAttribute('aria-live','polite');popover.footerButtons.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }});
  this.instance.highlight({element:element??undefined,popover:{title:safe(step.title),description:safe(step.description)+(note?`<p role="status">${safe(note)}</p>`:''),side:step.side,align:step.align}});
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();controls.pause();}else if(!['INPUT','TEXTAREA','SELECT'].includes((event.target as HTMLElement).tagName)){if(event.key==='ArrowRight'&&(!note||step.optional)){event.preventDefault();event.stopImmediatePropagation();controls.next();}if(event.key==='ArrowLeft'){event.preventDefault();event.stopImmediatePropagation();controls.previous();}}};document.addEventListener('keydown',key,true);this.off=()=>document.removeEventListener('keydown',key,true);
 }
 feedback(message:string){const host=this.lesson??document.querySelector<HTMLElement>('.cewen-tutorial-popover');if(!host)return;let node=host.querySelector<HTMLElement>('[data-feedback]');if(!node){node=document.createElement('p');node.dataset.feedback='';node.setAttribute('role','status');host.append(node);}node.textContent=message;}
 clear(){this.clearing=true;this.watcher?.disconnect();this.watcher=undefined;this.lesson?.remove();this.lesson=undefined;this.target?.classList.remove('tutorial-practice-target');this.target=undefined;this.off?.();this.off=undefined;const instance=this.instance;this.instance=undefined;instance?.destroy();if(this.priorFocus?.isConnected)this.priorFocus.focus({preventScroll:true});this.priorFocus=undefined;this.clearing=false;}
}
