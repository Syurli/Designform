import { composePrompt, emptyIdea, ideaBrief, promptScenes, type GameIdea, type IntegrationInfo, type PromptScene } from '../shared/prompts.ts';
import { categoryPresets } from '../shared/authoring.ts';
import type { KnowledgeGroup, ProjectSnapshot } from '../shared/model.ts';
import { escapeHtml as html } from './markdown-view';
import { request } from './project-client';

/** 复制失败保留可选中的全文，绝不显示虚假的复制或连接成功。 */
async function copy(text: HTMLTextAreaElement, status: HTMLElement) {
  try { await navigator.clipboard.writeText(text.value); status.textContent = '开场白已复制；请发送给你使用的 LLM。连接状态以实际接入为准。'; }
  catch { text.focus(); text.select(); status.textContent = '已选中全文，请按 Ctrl+C 复制。'; }
}

/** 所有场景复用同一开场白入口，快照和焦点来自调用处。 */
export async function openCollaboration(scene: PromptScene, snapshot?: ProjectSnapshot, documentIds: string[] = [],context:{extra?:string;title?:string;fixed?:boolean}={}) {
  const dialog = document.createElement('dialog'); dialog.className = 'project-dialog collaboration-dialog';
  dialog.innerHTML = `<header class="project-dialog-header"><div><h1>${html(context.title??(scene==='write'?'与 LLM 完善这份设计':scene==='review'?'与 LLM 检查设计关系':'与 LLM 继续这一步'))}</h1><p>上下文已经准备好，可以补充要求后直接复制。</p></div><button class="icon-button" data-close aria-label="关闭">×</button></header><label class="prompt-scene-label" ${context.fixed??(scene!=='start'||documentIds.length>0)?'hidden':''}>本轮任务<select id="prompt-scene">${promptScenes.map(item=>`<option value="${item[0]}" ${item[0]===scene?'selected':''}>${item[1]}</option>`).join('')}</select></label><textarea id="prompt-extra" rows="2" placeholder="补充这轮希望重点讨论的内容（可选）" aria-label="补充要求"></textarea><div class="prompt-actions"><button class="secondary-button" data-regenerate>按当前任务重新生成</button><button class="secondary-button" data-personal>套用我的常用要求</button><button class="secondary-button" data-remember>保存为常用要求</button></div><textarea id="collaboration-prompt" rows="16" aria-label="发送给 LLM 的开场白" spellcheck="false" readonly>正在准备实际接入信息…</textarea><div class="prompt-actions"><button class="primary-button" data-copy disabled>复制开场白</button><span role="status">不会自动发送、采纳设计或创建版本。</span></div>`;
  document.body.append(dialog); dialog.showModal();
  const area = dialog.querySelector<HTMLTextAreaElement>('#collaboration-prompt')!, extra = dialog.querySelector<HTMLTextAreaElement>('#prompt-extra')!, status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  extra.value=context.extra??'';
  let integration: IntegrationInfo = { mode: 'web' };
  try { integration = await request<IntegrationInfo>('/api/integration'); } catch { status.textContent = '接入信息暂不可用，已准备文件协作开场白。'; }
  if (!dialog.isConnected) return;
  const generate = () => { area.value = composePrompt({ scene: (dialog.querySelector('#prompt-scene') as HTMLSelectElement).value as PromptScene, snapshot, documentIds, integration, extra: extra.value }); };
  generate(); area.readOnly = false; dialog.querySelector<HTMLButtonElement>('[data-copy]')!.disabled = false;
  dialog.addEventListener('click', event => { const button = (event.target as HTMLElement).closest('button'); if (!button) return;
    if (button.hasAttribute('data-close')) dialog.close();
    if (button.hasAttribute('data-copy')) void copy(area,status);
    if (button.hasAttribute('data-regenerate')) generate();
    if (button.hasAttribute('data-remember')) { try { localStorage.setItem('cewen-prompt-preference',extra.value); status.textContent='常用要求已保存在本机。'; } catch { status.textContent='本机存储不可用，请复制保留。'; } }
    if (button.hasAttribute('data-personal')) { extra.value=localStorage.getItem('cewen-prompt-preference') ?? ''; status.textContent='已填入常用要求；点击重新生成以应用，现有开场白保留。'; }
  });
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
}

/** 起步范例只更改选择与草稿，不调用模型，不创建正式文件。 */
export function mountCreationComposer(container: HTMLElement, create: (setup: { brief: string; categories: KnowledgeGroup[] }) => void) {
  let idea = emptyIdea();
  try { const saved=JSON.parse(localStorage.getItem('cewen-game-idea') ?? 'null'); if (saved && typeof saved.idea==='string' && Array.isArray(saved.genres) && Array.isArray(saved.gameplay)) idea={...idea,...saved}; } catch { /* 无有效私人草稿时从空白开始。 */ }
  const options=(key: 'genres'|'gameplay',values:string[])=>values.map(value=>`<button type="button" data-idea-choice="${key}" data-value="${value}" aria-pressed="${idea[key].includes(value)}">${value}</button>`).join('');
  const select=(key:'platform'|'team'|'session',label:string,values:string[])=>`<label>${label}<select data-idea-field="${key}" aria-label="${label}">${['待讨论',...values].map(value=>`<option ${(idea[key]||'待讨论')===value?'selected':''}>${value}</option>`).join('')}</select></label>`;
  container.innerHTML=`<div class="creation-heading"><h2>你想做一款怎样的游戏？</h2><p class="quiet">从一句话开始，选项可以跳过，也可以自由组合。</p></div><div class="creation-grid"><section><div class="idea-options idea-presets">${['探索原型','卡牌构筑','模拟经营','叙事冒险','还没想清楚'].map(label=>`<button type="button" data-idea-preset="${label}">${label}</button>`).join('')}</div><textarea data-idea-field="idea" rows="3" aria-label="一句话游戏设想" placeholder="我想让玩家……">${html(idea.idea)}</textarea><label>游戏类型 · 可组合</label><div class="idea-options">${options('genres',['动作','角色扮演','射击','策略战术','模拟经营','解谜探索','卡牌构筑','叙事'])}</div><input data-idea-field="customGenre" value="${html(idea.customGenre)}" placeholder="自定义类型" aria-label="自定义类型"/><label>本轮规模与目标</label><select data-idea-field="scope" aria-label="规模与目标">${['尚未确定','验证核心玩法','可玩演示','规划完整作品'].map(value=>`<option ${idea.scope===value?'selected':''}>${value}</option>`).join('')}</select><label>玩家主要做什么</label><div class="idea-options">${options('gameplay',['探索','战斗','构筑','解谜','经营','建造','叙事选择'])}</div><input data-idea-field="customPlay" value="${html(idea.customPlay)}" placeholder="自由描述主要玩法" aria-label="自定义玩法"/><details><summary>补充平台、资源、偏好与限制</summary>${select('platform','目标平台',['PC','移动端','主机','浏览器','跨平台'])}${select('team','开发资源',['个人创作','2～5 人小团队','6～15 人团队','更大规模团队'])}${select('session','单次体验时长',['5～15 分钟','15～30 分钟','30～60 分钟','1 小时以上'])}<textarea data-idea-field="constraints" rows="3" aria-label="补充限制" placeholder="已确定的条件、想尝试的方向、不希望出现的内容……">${html(idea.constraints)}</textarea></details><label>希望怎样一起讨论</label><select data-idea-field="approach" aria-label="协作方式">${['先问我关键问题','给几种方向比较','基于已知约束起草候选初稿','只整理已有想法'].map(value=>`<option ${idea.approach===value?'selected':''}>${value}</option>`).join('')}</select></section><section><div class="prompt-actions"><label for="creation-prompt">开场白 · 可自由改写</label><button type="button" class="secondary-button" data-idea-regenerate>重新生成</button></div><textarea id="creation-prompt" rows="18" spellcheck="false" aria-label="新项目开场白"></textarea><details><summary>手动创建时选用的设计分类</summary><button type="button" class="secondary-button" data-idea-categories>按游戏类型推荐分类</button><div class="idea-options">${categoryPresets.map(group=>`<label class="category-check"><input type="checkbox" value="${group.id}"/>${html(group.label)}</label>`).join('')}</div></details><div class="prompt-actions"><button class="primary-button" type="button" data-idea-copy>复制给 LLM</button><button class="secondary-button" type="button" data-idea-create>用设想手动创建</button></div><p role="status" class="quiet">所有选项都是讨论起点，不会自动成为游戏规则。</p></section></div>`;
  const area=container.querySelector<HTMLTextAreaElement>('#creation-prompt')!, status=container.querySelector<HTMLElement>('[role="status"]')!;let edited=false;
  let integration: IntegrationInfo = {mode:'web'};
  const generate=()=>{area.value=composePrompt({scene:'start',idea,integration});edited=false;};
  // 接入信息晚返回时只更新未被手改的开场白。
  void request<IntegrationInfo>('/api/integration').then(value=>{integration=value;if(!edited&&container.isConnected)generate();}).catch(()=>{});
  const save=()=>{try {localStorage.setItem('cewen-game-idea',JSON.stringify(idea));}catch {status.textContent='私人草稿暂不能保存，请复制保留。';}};
  const update=()=>{save();if(!edited)generate();else status.textContent='保留手改开场白；需要采用新选项时，点击重新生成。';container.querySelectorAll<HTMLButtonElement>('[data-idea-choice]').forEach(button=>button.setAttribute('aria-pressed',String(idea[button.dataset.ideaChoice as 'genres'|'gameplay'].includes(button.dataset.value!))));};
  area.addEventListener('input',()=>{edited=true;});
  container.addEventListener('input',event=>{const field=event.target as HTMLInputElement,key=field.dataset.ideaField;if(key){(idea as unknown as Record<string,unknown>)[key]=field.value;update();}});
  container.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
    if(button.dataset.ideaChoice){const key=button.dataset.ideaChoice as 'genres'|'gameplay',value=button.dataset.value!;idea[key]=idea[key].includes(value)?idea[key].filter(item=>item!==value):[...idea[key],value];update();}
    if(button.dataset.ideaPreset){const preset=button.dataset.ideaPreset;idea.genres=preset==='卡牌构筑'?['卡牌构筑']:preset==='模拟经营'?['模拟经营']:preset==='叙事冒险'?['叙事']:preset==='探索原型'?['解谜探索']:[];idea.gameplay=preset==='卡牌构筑'?['构筑']:preset==='模拟经营'?['经营']:preset==='叙事冒险'?['叙事选择']:preset==='探索原型'?['探索']:[];update();}
    if(button.hasAttribute('data-idea-categories')) {
      // 推荐只勾选目录，可再取消；不生成 DD 或已确认玩法。
      const byGenre:Record<string,string[]>={'动作':['controls','combat','ai','feedback'],'角色扮演':['growth','items','story','world'],'射击':['controls','combat','items','network'],'策略战术':['combat','ai','world','economy'],'模拟经营':['economy','world','progress'],'解谜探索':['world','controls','story'],'卡牌构筑':['combat','growth','items'],'叙事':['story','world','progress']};
      const selected=new Set(['experience','interface',...idea.genres.flatMap(genre=>byGenre[genre]??[])].map(id=>'system-'+id));
      container.querySelectorAll<HTMLInputElement>('.category-check input').forEach(input=>{input.checked=selected.has(input.value);});status.textContent='已勾选推荐分类，可以自由取消或补充；创建项目时才写入。';
    }
    if(button.hasAttribute('data-idea-regenerate'))generate();
    if(button.hasAttribute('data-idea-copy'))void copy(area,status);
    if(button.hasAttribute('data-idea-create')){save();const selected=[...container.querySelectorAll<HTMLInputElement>('.category-check input:checked')].map(input=>input.value);create({brief:ideaBrief(idea),categories:categoryPresets.filter(group=>selected.includes(group.id))});}
  });generate();
}
