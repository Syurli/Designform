import type { KnowledgeNode, ProjectSnapshot } from '../shared/model';
import { escapeHtml } from './markdown-view';

/** 所有手工关联入口按人类标题检索；身份只用作内部选值，不要求填写。 */
export function pickDocument(snapshot:ProjectSnapshot,options:{title?:string;exclude?:string|string[];external?:boolean}={}):Promise<KnowledgeNode|string|null>{
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='document-picker-dialog';
    dialog.innerHTML=`<header><strong>${escapeHtml(options.title??'链接到文档')}</strong><button type="button" aria-label="关闭文档选择">×</button></header><input type="search" aria-label="搜索文档标题或网址" placeholder="${options.external?'搜索文档标题，或粘贴 https:// 网址':'按文档或规则标题搜索'}"/><div class="document-picker-results"></div>`;
    document.body.append(dialog);
    const input=dialog.querySelector('input')!,results=dialog.querySelector('div')!;
    const finish=(value:KnowledgeNode|string|null)=>{dialog.close();dialog.remove();resolve(value);};
    const render=()=>{
      const query=input.value.trim(),items=snapshot.nodes.filter(node=>node.kind!=='system'&&!(Array.isArray(options.exclude)?options.exclude:[options.exclude]).includes(node.id)&&node.status!=='archived'&&`${node.title} ${snapshot.groups.find(group=>group.id===node.group)?.label??''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,60);
      results.replaceChildren();
      if(options.external&&/^https?:\/\//i.test(query)){const button=document.createElement('button');button.type='button';button.textContent=`插入网页链接：${query}`;button.onclick=()=>finish(query);results.append(button);}
      for(const node of items){const button=document.createElement('button');button.type='button';button.innerHTML=`<strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(snapshot.groups.find(group=>group.id===node.group)?.label??'未归组')}${node.kind==='rule'?' · 规则条目':''}</small><span>${escapeHtml(node.summary.slice(0,100))}</span>`;button.onclick=()=>finish(node);results.append(button);}
      if(!results.childElementCount)results.textContent='没有匹配的文档。';
    };
    dialog.querySelector('header button')!.addEventListener('click',()=>finish(null));
    dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();finish(null);});
    input.addEventListener('input',render);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();results.querySelector<HTMLButtonElement>('button')?.click();}if(event.key==='ArrowDown'){event.preventDefault();results.querySelector<HTMLButtonElement>('button')?.focus();}});
    render();dialog.showModal();input.focus();
  });
}
