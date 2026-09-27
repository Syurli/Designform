import { h } from './creative/render';
import { prepareDirectoryFields } from './edition';

/** 少量任务型对话框共用键盘、错误保留和忙碌状态；日常文档编辑不使用模态窗口。 */
export function appForm<T>(title:string,body:string,submit:string,run:(data:FormData)=>Promise<T>|T):Promise<T|undefined> {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='project-dialog desktop-task-dialog';let busy=false;
    dialog.innerHTML=`<form><header><h2>${h(title)}</h2><button type="button" data-cancel aria-label="关闭">×</button></header><div class="task-body">${body}</div><p role="status" aria-live="polite"></p><footer><button type="button" data-cancel>取消</button><button type="submit" class="primary-button">${h(submit)}</button></footer></form>`;
    const close=()=>{if(busy)return;dialog.close();dialog.remove();resolve(undefined);};
    dialog.oncancel=e=>{e.preventDefault();e.stopPropagation();close();};
    dialog.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',close));
    dialog.onsubmit=e=>{e.preventDefault();if(busy)return;busy=true;dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);Promise.resolve().then(()=>run(new FormData(dialog.querySelector('form')!))).then(value=>{dialog.close();dialog.remove();resolve(value);}).catch(error=>{dialog.querySelector('[role=status]')!.textContent=error.message??String(error);}).finally(()=>{busy=false;dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);});};
    document.body.append(dialog);prepareDirectoryFields(dialog);dialog.showModal();
  });
}
export const appChoice=(title:string,message:string,choices:{id:string;label:string}[])=>appForm(title,`<p>${h(message)}</p>${choices.map((c,i)=>`<label class="task-choice"><input type="radio" name="choice" value="${h(c.id)}" ${i===0?'checked':''}/>${h(c.label)}</label>`).join('')}`,'继续',data=>String(data.get('choice')));
