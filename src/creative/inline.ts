import {inquiry} from '../../shared/inquiry';
import type { ProjectDocument,ProjectSnapshot } from '../../shared/model';
import { buildCreativeIndex,parseObject } from '../../shared/creative/content';
import { h,objectCard,hydrateMedia } from './render';
import { mountQuestions,relatedQuestions } from './questions';
import { readHeader } from '../../shared/markdown';
/** 专用阅读与普通文档显示同一模块，问题层只是视图。 */
export function mountCreativeBlocks(root:HTMLElement,snapshot:ProjectSnapshot){const index=buildCreativeIndex(snapshot);for(const el of root.querySelectorAll<HTMLElement>('[data-creative-source]')){try{el.innerHTML=objectCard(parseObject(el.dataset.creativeSource??''),index);}catch(e){el.innerHTML=`<p class="creative-warning">${h((e as Error).message)}</p>`;}}
  // 引用卡默认只读，摘要来自相同快照；不递归展开引用，避免环造成无限渲染。
  for(const el of root.querySelectorAll<HTMLElement>('[data-document-reference]')){
    const doc=snapshot.documents.find(d=>d.id===el.dataset.documentReference);
    el.innerHTML=doc?`<small>源文档 · ${h(readHeader(doc.text).metadata.purpose||'基础文档')}</small><h4>${h(doc.title)}</h4><p>${h(readHeader(doc.text).body.replace(/\x60{3}[\s\S]*?\x60{3}/g,'').replace(/<!--[\s\S]*?-->/g,'').replace(/^#+\s.*/gm,'').trim().slice(0,350))}</p><button type="button" data-source-document="${h(doc.id)}">打开源文档</button>`:`<p class="creative-warning">${el.dataset.documentReference?'来源文档已缺失，引用身份仍保留。':'待选择源文档。'}</p>`;
  }
  return hydrateMedia(root,snapshot,index);
}
export function mountDocumentQuestions(root:HTMLElement,header:HTMLElement,paper:HTMLElement,doc:ProjectDocument,snapshot:ProjectSnapshot){
 const row=document.createElement('div');row.className='creative-document-actions';row.innerHTML=`<button data-document-module="${h(doc.id)}">＋ 插入模块</button><button data-document-quest="${h(doc.id)}">对本页 / 选区发起 Quest</button><label>问题层<select><option value="body">正文</option><option value="both">正文＋问题</option><option value="questions">仅问题</option></select></label>`;header.after(row);
 const related=relatedQuestions(snapshot,doc.id),host=document.createElement('section');host.className='creative-inline-questions';host.hidden=true;paper.after(host);const mode=row.querySelector('select')!;mode.onchange=()=>{paper.hidden=mode.value==='questions';host.hidden=mode.value==='body';};
 const dispose=mountQuestions(host,snapshot,related,next=>window.dispatchEvent(new CustomEvent('cewen:creative-apply',{detail:next})));
 const badge=document.createElement('small');badge.textContent=`${related.filter(d=>inquiry(d).status!=='decided').length} 个待处理 / ${related.length} 个问题`;row.append(badge);
 return()=>{dispose();row.remove();host.remove();};
}
