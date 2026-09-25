import {inquiry} from '../../shared/inquiry';
import type { ProjectDocument,ProjectSnapshot } from '../../shared/model';
import { buildCreativeIndex,parseObject } from '../../shared/creative/content';
import { h,objectCard,hydrateMedia } from './render';
import { mountQuestions,relatedQuestions } from './questions';
/** 专用阅读与普通文档显示同一模块，问题层只是视图。 */
export function mountCreativeBlocks(root:HTMLElement,snapshot:ProjectSnapshot){const index=buildCreativeIndex(snapshot);for(const el of root.querySelectorAll<HTMLElement>('[data-creative-source]')){try{el.innerHTML=objectCard(parseObject(el.dataset.creativeSource??''),index);}catch(e){el.innerHTML=`<p class="creative-warning">${h((e as Error).message)}</p>`;}}return hydrateMedia(root,snapshot,index);}
export function mountDocumentQuestions(root:HTMLElement,header:HTMLElement,paper:HTMLElement,doc:ProjectDocument,snapshot:ProjectSnapshot){
 const row=document.createElement('div');row.className='creative-document-actions';row.innerHTML=`<button data-document-module="${h(doc.id)}">＋ 插入模块</button><button data-document-quest="${h(doc.id)}">对本页 / 选区发起 Quest</button><label>问题层<select><option value="body">正文</option><option value="both">正文＋问题</option><option value="questions">仅问题</option></select></label>`;header.after(row);
 const related=relatedQuestions(snapshot,doc.id),host=document.createElement('section');host.className='creative-inline-questions';host.hidden=true;paper.after(host);const mode=row.querySelector('select')!;mode.onchange=()=>{paper.hidden=mode.value==='questions';host.hidden=mode.value==='body';};
 const dispose=mountQuestions(host,snapshot,related,next=>window.dispatchEvent(new CustomEvent('cewen:creative-apply',{detail:next})));
 const badge=document.createElement('small');badge.textContent=`${related.filter(d=>inquiry(d).status!=='decided').length} 个待处理 / ${related.length} 个问题`;row.append(badge);
 return()=>{dispose();row.remove();host.remove();};
}
