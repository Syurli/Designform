import { inputPreferences } from './input-settings';

/** Windows 可能在右键按下时先发 contextmenu；统一延后到松开，位移超过阈值则只允许拖动。 */
export function initializeContextGestures(){
  let held:{pointer:number;x:number;y:number;moved:boolean;menu?:MouseEvent;target?:EventTarget|null}|undefined;
  let blockUntil=0,replaying=false;
  window.addEventListener('pointerdown',event=>{if(event.button!==2)return;blockUntil=0;held=undefined;if((event.target as HTMLElement).closest('input,textarea,select'))return;held={pointer:event.pointerId,x:event.clientX,y:event.clientY,moved:false};},{capture:true});
  window.addEventListener('pointermove',event=>{if(held&&held.pointer===event.pointerId&&Math.hypot(event.clientX-held.x,event.clientY-held.y)>=inputPreferences().dragThreshold)held.moved=true;},{capture:true});
  window.addEventListener('contextmenu',event=>{
    if(replaying||event.button!==2||(event.target as HTMLElement).closest('input,textarea,select'))return;
    if(held){held.menu=event;held.target=event.target;event.preventDefault();event.stopImmediatePropagation();}
    else if(performance.now()<blockUntil){event.preventDefault();event.stopImmediatePropagation();}
  },{capture:true});
  window.addEventListener('pointerup',event=>{if(!held||held.pointer!==event.pointerId)return;const gesture=held;held=undefined;
    if(gesture.moved){blockUntil=performance.now()+600;return;}
    if(gesture.menu&&gesture.target instanceof Element){blockUntil=performance.now()+600;queueMicrotask(()=>{if(!gesture.target||!(gesture.target as Element).isConnected)return;replaying=true;try{gesture.target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:event.clientX,clientY:event.clientY,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey}));}finally{replaying=false;}});}
  },{capture:true});
  // 取消与失焦也不能把尚未完成的框选误解释成一次菜单点击。
  const cancel=()=>{if(held)blockUntil=performance.now()+600;held=undefined;};window.addEventListener('pointercancel',cancel,{capture:true});window.addEventListener('blur',cancel);
}
