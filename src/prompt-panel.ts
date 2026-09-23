import { composePrompt, emptyIdea, ideaBrief, promptScenes, type GameIdea, type IntegrationInfo, type PromptScene } from '../shared/prompts.ts';
import { categoryPresets } from '../shared/authoring.ts';
import type { KnowledgeGroup, LlmConnectionState, ProjectSnapshot } from '../shared/model.ts';
import { escapeHtml as html } from './markdown-view';
import { readConnections, request } from './project-client';

/** 复制失败保留可选中的全文，绝不显示虚假的复制或连接成功。 */
async function copy(text: HTMLTextAreaElement, status: HTMLElement) {
  try { await navigator.clipboard.writeText(text.value); status.textContent = '开场白已复制；请发送给你使用的 LLM。连接状态以实际接入为准。'; }
  catch { text.focus(); text.select(); status.textContent = '已选中全文，请按 Ctrl+C 复制。'; }
}

/** 只比较会改变开场白分支的运行期连接信息，不把心跳时间变化当成新连接。 */
function connectionKey(state?: LlmConnectionState) {
  return state ? state.connections.map(item=>`${item.id}:${item.status}:${item.projectId??''}`).sort().join('|') : 'unknown';
}
function connectionLabel(integration: IntegrationInfo, state?: LlmConnectionState) {
  if(integration.mode==='web')return '网页版文件协作';
  if(integration.mode==='unknown'||!state)return '连接状态暂不可用';
  const count=state.connections.filter(item=>item.status==='connected').length;
  return count?`已检测客户端 ${count} 个`:'未连接 MCP';
}

/** 所有场景复用同一开场白入口，快照和焦点来自调用处。 */
export async function openCollaboration(scene: PromptScene, snapshot?: ProjectSnapshot, documentIds: string[] = [],context:{extra?:string;title?:string;fixed?:boolean}={}) {
  const dialog = document.createElement('dialog'); dialog.className = 'project-dialog collaboration-dialog';
  dialog.innerHTML = `<header class="project-dialog-header"><div><h1>${html(context.title??(scene==='write'?'与 LLM 完善这份设计':scene==='review'?'与 LLM 检查设计关系':'与 LLM 继续这一步'))}</h1><p>上下文已经准备好，可以补充要求后直接复制。</p></div><button class="icon-button" data-close aria-label="关闭">×</button></header><label class="prompt-scene-label" ${context.fixed??(scene!=='start'||documentIds.length>0)?'hidden':''}>本轮任务<select id="prompt-scene">${promptScenes.map(item=>`<option value="${item[0]}" ${item[0]===scene?'selected':''}>${item[1]}</option>`).join('')}</select></label><textarea id="prompt-extra" rows="2" placeholder="补充这轮希望重点讨论的内容（可选）" aria-label="补充要求"></textarea><div class="prompt-actions"><button class="secondary-button" data-regenerate>按当前任务重新生成</button><button class="secondary-button" data-personal>套用我的常用要求</button><button class="secondary-button" data-remember>保存为常用要求</button></div><p class="quiet" data-prompt-connection>正在读取连接状态…</p><textarea id="collaboration-prompt" rows="16" aria-label="发送给 LLM 的开场白" spellcheck="false" readonly>正在准备实际接入信息…</textarea><div class="prompt-actions"><button class="primary-button" data-copy disabled>复制开场白</button><span role="status">不会自动发送、采纳设计或创建版本。</span></div>`;
  document.body.append(dialog); dialog.showModal();
  const area = dialog.querySelector<HTMLTextAreaElement>('#collaboration-prompt')!, extra = dialog.querySelector<HTMLTextAreaElement>('#prompt-extra')!, status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  extra.value=context.extra??'';
  let integration: IntegrationInfo = { mode: 'unknown' }, connections: LlmConnectionState | undefined;
  const [integrationResult, connectionResult] = await Promise.allSettled([request<IntegrationInfo>('/api/integration'), readConnections()]);
  if (integrationResult.status === 'fulfilled') integration = integrationResult.value;
  else status.textContent = '接入信息暂不可用，已准备文件协作开场白。';
  if (connectionResult.status === 'fulfilled') connections = connectionResult.value;
  if (!dialog.open) {dialog.remove();return;}
  const label=dialog.querySelector<HTMLElement>('[data-prompt-connection]')!;
  let edited=false, key=connectionKey(connections);
  const generate = () => { area.value = composePrompt({ scene: (dialog.querySelector('#prompt-scene') as HTMLSelectElement).value as PromptScene, snapshot, documentIds, integration, connections, extra: extra.value }); edited=false; key=connectionKey(connections); label.textContent=connectionLabel(integration,connections); };
  generate(); area.readOnly = false; dialog.querySelector<HTMLButtonElement>('[data-copy]')!.disabled = false;
  area.addEventListener('input',()=>{edited=true;});
  // 对话框打开期间追踪状态；手改文本保持原样，只提示用户按需重新生成。
  const refresh=async()=>{try{const next=await readConnections();if(!dialog.isConnected||!dialog.open)return;const nextKey=connectionKey(next);connections=next;label.textContent=connectionLabel(integration,connections);if(nextKey!==key){if(edited)status.textContent='连接状态已变化；手改开场白已保留，可重新生成。';else{generate();status.textContent='开场白已按当前连接状态更新，请重新复制。';}}}catch{if(!dialog.isConnected||!dialog.open)return;connections=undefined;label.textContent=connectionLabel(integration);if(key!=='unknown'){if(edited)status.textContent='连接状态暂不可用；手改开场白已保留，可重新生成。';else{generate();status.textContent='连接状态暂不可用，开场白已更新，请重新复制。';}}}};
  const timer=setInterval(()=>{if(!document.hidden)void refresh();},4000);
  dialog.addEventListener('click', event => { const button = (event.target as HTMLElement).closest('button'); if (!button) return;
    if (button.hasAttribute('data-close')) dialog.close();
    if (button.hasAttribute('data-copy')) void copy(area,status);
    if (button.hasAttribute('data-regenerate')) { const before=area.value; void readConnections().then(value=>{ connections=value; if(area.value===before)generate(); }).catch(()=>{ connections=undefined; if(area.value===before)generate(); }); }
    if (button.hasAttribute('data-remember')) { try { localStorage.setItem('cewen-prompt-preference',extra.value); status.textContent='常用要求已保存在本机。'; } catch { status.textContent='本机存储不可用，请复制保留。'; } }
    if (button.hasAttribute('data-personal')) { extra.value=localStorage.getItem('cewen-prompt-preference') ?? ''; status.textContent='已填入常用要求；点击重新生成以应用，现有开场白保留。'; }
  });
  dialog.addEventListener('close',()=>{clearInterval(timer);dialog.remove();},{once:true});
}

/** 起步范例只更改选择与草稿，不调用模型，不创建正式文件。 */
export function mountCreationComposer(container: HTMLElement, create: (setup: { brief: string; categories: KnowledgeGroup[] }) => void) {
  let idea = emptyIdea();
  let savedPrompt='',savedEdited=false,savedCategories:string[]=[];
  try {
    const saved: unknown=JSON.parse(localStorage.getItem('cewen-creation-composer')??'null');
    if(saved&&typeof saved==='object'&&!Array.isArray(saved)){
      const data=saved as Record<string,unknown>;
      if(typeof data.prompt==='string'&&data.edited===true){savedPrompt=data.prompt;savedEdited=true;}
      if(Array.isArray(data.categories))savedCategories=data.categories.filter((id):id is string=>typeof id==='string');
    }
  }catch{ /* 私人拼装器草稿损坏时保留可读取的游戏设想。 */ }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('cewen-game-idea') ?? 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const old = saved as Record<string, unknown>;
      const words = (value: unknown) => Array.isArray(value) ? value.filter((word): word is string => typeof word === 'string') : [];
      // 旧私人草稿的单选目标和平台转为多选；损坏字段逐项忽略，保留其他有效输入。
      idea = {
        ...idea,
        idea: typeof old.idea === 'string' ? old.idea : '',
        genres: words(old.genres), gameplay: words(old.gameplay),
        goals: words(old.goals).length ? words(old.goals) : typeof old.scope === 'string' && old.scope !== '尚未确定' ? [old.scope] : [],
        platforms: words(old.platforms).length ? words(old.platforms) : typeof old.platform === 'string' && old.platform !== '待讨论' ? [old.platform] : [],
        customGenre: typeof old.customGenre === 'string' ? old.customGenre : '',
        customGoal: typeof old.customGoal === 'string' ? old.customGoal : '',
        customPlay: typeof old.customPlay === 'string' ? old.customPlay : '',
        customPlatform: typeof old.customPlatform === 'string' ? old.customPlatform : '',
        constraints: typeof old.constraints === 'string' ? old.constraints : '',
        approach: typeof old.approach === 'string' ? old.approach : idea.approach,
        team: typeof old.team === 'string' ? old.team : undefined,
        session: typeof old.session === 'string' ? old.session : undefined,
      };
    }
  } catch { /* 无有效私人草稿时从空白开始。 */ }
  const options=(key: 'genres'|'goals'|'gameplay'|'platforms',values:string[])=>values.map(value=>`<button type="button" data-idea-choice="${key}" data-value="${value}" aria-pressed="${idea[key].includes(value)}">${value}</button>`).join('');
  const select=(key:'team'|'session',label:string,values:string[])=>`<label>${label}<select data-idea-field="${key}" aria-label="${label}">${['待讨论',...values].map(value=>`<option ${(idea[key]||'待讨论')===value?'selected':''}>${value}</option>`).join('')}</select></label>`;
  container.innerHTML=`<div class="creation-heading"><h2>你想做一款怎样的游戏？</h2><p class="quiet">从一句话开始，选项可以跳过，也可以自由组合。</p></div><div class="creation-grid"><section><div class="idea-options idea-presets">${['探索原型','卡牌构筑','模拟经营','叙事冒险','还没想清楚'].map(label=>`<button type="button" data-idea-preset="${label}">${label}</button>`).join('')}</div><textarea data-idea-field="idea" rows="3" aria-label="一句话游戏设想" placeholder="我想让玩家……">${html(idea.idea)}</textarea><label>游戏类型 · 可组合</label><div class="idea-options">${options('genres',['动作','角色扮演','射击','策略战术','模拟经营','解谜探索','卡牌构筑','叙事'])}</div><input data-idea-field="customGenre" value="${html(idea.customGenre)}" placeholder="自定义类型" aria-label="自定义类型"/><label>本轮目标 · 可组合</label><div class="idea-options">${options('goals',['验证核心玩法','可玩演示','规划完整作品','寻找独特体验','梳理设计框架'])}</div><input data-idea-field="customGoal" value="${html(idea.customGoal)}" placeholder="自定义目标" aria-label="自定义目标"/><label>玩家主要做什么 · 可组合</label><div class="idea-options">${options('gameplay',['探索','战斗','构筑','解谜','经营','建造','叙事选择'])}</div><input data-idea-field="customPlay" value="${html(idea.customPlay)}" placeholder="自由描述主要玩法" aria-label="自定义玩法"/><label>目标平台 · 可组合</label><div class="idea-options">${options('platforms',['PC','移动端','主机','浏览器'])}</div><input data-idea-field="customPlatform" value="${html(idea.customPlatform)}" placeholder="自定义平台或组合" aria-label="自定义平台"/><details><summary>补充资源、时长与限制</summary>${select('team','开发资源',['个人创作','2～5 人小团队','6～15 人团队','更大规模团队'])}${select('session','单次体验时长',['5～15 分钟','15～30 分钟','30～60 分钟','1 小时以上'])}<textarea data-idea-field="constraints" rows="3" aria-label="补充限制" placeholder="已确定的条件、想尝试的方向、不希望出现的内容……">${html(idea.constraints)}</textarea></details><label>希望怎样一起讨论</label><select data-idea-field="approach" aria-label="协作方式">${['先问我关键问题','给几种方向比较','基于已知约束起草候选初稿','只整理已有想法'].map(value=>`<option ${idea.approach===value?'selected':''}>${value}</option>`).join('')}</select></section><section><div class="prompt-actions"><label for="creation-prompt">开场白 · 可自由改写</label><button type="button" class="secondary-button" data-idea-regenerate>重新生成</button></div><p class="quiet" data-creation-connection>正在读取连接状态…</p><textarea id="creation-prompt" rows="18" spellcheck="false" aria-label="新项目开场白"></textarea><details><summary>手动创建时选用的设计分类</summary><button type="button" class="secondary-button" data-idea-categories>按游戏类型推荐分类</button><div class="idea-options">${categoryPresets.map(group=>`<label class="category-check"><input type="checkbox" value="${group.id}"/>${html(group.label)}</label>`).join('')}</div></details><div class="prompt-actions"><button class="primary-button" type="button" data-idea-copy>复制给 LLM</button><button class="secondary-button" type="button" data-idea-create>用设想手动创建</button></div><p role="status" class="quiet">所有选项都是讨论起点，不会自动成为游戏规则。</p></section></div>`;
  const area=container.querySelector<HTMLTextAreaElement>('#creation-prompt')!, status=container.querySelector<HTMLElement>('[role="status"]')!,label=container.querySelector<HTMLElement>('[data-creation-connection]')!;
  container.querySelectorAll<HTMLInputElement>('.category-check input').forEach(input=>{input.checked=savedCategories.includes(input.value);});
  let edited=savedEdited,key='unknown';
  let integration: IntegrationInfo = {mode:'unknown'}, connections: LlmConnectionState | undefined;
  const save=()=>{try {localStorage.setItem('cewen-game-idea',JSON.stringify(idea));localStorage.setItem('cewen-creation-composer',JSON.stringify({edited,prompt:edited?area.value:'',categories:[...container.querySelectorAll<HTMLInputElement>('.category-check input:checked')].map(input=>input.value)}));}catch {status.textContent='私人草稿暂不能保存，请复制保留。';}};
  const generate=()=>{area.value=composePrompt({scene:'start',idea,integration,connections});edited=false;key=connectionKey(connections);label.textContent=connectionLabel(integration,connections);save();};
  // 接入信息和真实心跳晚返回时只更新未被手改的开场白。
  void Promise.allSettled([request<IntegrationInfo>('/api/integration'),readConnections()]).then(([info,state])=>{
    if(info.status==='fulfilled')integration=info.value;
    if(state.status==='fulfilled')connections=state.value;
    if(container.isConnected){label.textContent=connectionLabel(integration,connections);if(!edited)generate();else status.textContent='已恢复手改开场白；连接状态变化后可重新生成。';}
  });
  // 拼装器被上一级页面替换时立即停止轮询；异步响应也会检查节点是否仍在页面。
  const timer=setInterval(()=>{if(!container.isConnected){clearInterval(timer);return;}if(document.hidden)return;void readConnections().then(next=>{if(!container.isConnected)return;connections=next;label.textContent=connectionLabel(integration,connections);if(connectionKey(next)!==key){if(edited)status.textContent='连接状态已变化；手改开场白已保留，可重新生成。';else{generate();status.textContent='开场白已按当前连接状态更新，请重新复制。';}}}).catch(()=>{if(!container.isConnected)return;connections=undefined;label.textContent=connectionLabel(integration);if(key!=='unknown'){if(edited)status.textContent='连接状态暂不可用；手改开场白已保留，可重新生成。';else{generate();status.textContent='连接状态暂不可用，开场白已更新，请重新复制。';}}});},4000);
  const removalObserver=new MutationObserver(()=>{if(!container.isConnected){clearInterval(timer);removalObserver.disconnect();}});
  removalObserver.observe(document.body,{childList:true,subtree:true});
  // 工作台 close() 保留对话框 DOM；关闭时也必须停止轮询与观察。
  container.closest('dialog')?.addEventListener('close',()=>{clearInterval(timer);removalObserver.disconnect();},{once:true});
  const update=()=>{save();if(!edited)generate();else status.textContent='保留手改开场白；需要采用新选项时，点击重新生成。';container.querySelectorAll<HTMLButtonElement>('[data-idea-choice]').forEach(button=>button.setAttribute('aria-pressed',String(idea[button.dataset.ideaChoice as 'genres'|'goals'|'gameplay'|'platforms'].includes(button.dataset.value!))));};
  area.addEventListener('input',()=>{edited=true;save();});
  container.querySelectorAll<HTMLInputElement>('.category-check input').forEach(input=>input.addEventListener('change',save));
  container.addEventListener('input',event=>{const field=event.target as HTMLInputElement,key=field.dataset.ideaField;if(key){(idea as unknown as Record<string,unknown>)[key]=field.value;update();}});
  container.addEventListener('change',event=>{const field=event.target as HTMLSelectElement;if(field.dataset.ideaField){(idea as unknown as Record<string,unknown>)[field.dataset.ideaField]=field.value;update();}});
  container.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
    if(button.dataset.ideaChoice){const key=button.dataset.ideaChoice as 'genres'|'goals'|'gameplay'|'platforms',value=button.dataset.value!;idea[key]=idea[key].includes(value)?idea[key].filter(item=>item!==value):[...idea[key],value];update();}
    if(button.dataset.ideaPreset){
      // 快捷范例只补充建议词条，不清空用户已组合的设想。
      const preset=button.dataset.ideaPreset;
      const genre=preset==='卡牌构筑'?'卡牌构筑':preset==='模拟经营'?'模拟经营':preset==='叙事冒险'?'叙事':preset==='探索原型'?'解谜探索':'';
      const play=preset==='卡牌构筑'?'构筑':preset==='模拟经营'?'经营':preset==='叙事冒险'?'叙事选择':preset==='探索原型'?'探索':'';
      if(genre&&!idea.genres.includes(genre))idea.genres.push(genre);
      if(play&&!idea.gameplay.includes(play))idea.gameplay.push(play);
      update();
    }
    if(button.hasAttribute('data-idea-categories')) {
      // 推荐只勾选目录，可再取消；不生成 DD 或已确认玩法。
      const byGenre:Record<string,string[]>={'动作':['controls','combat','ai','feedback'],'角色扮演':['growth','items','story','world'],'射击':['controls','combat','items','network'],'策略战术':['combat','ai','world','economy'],'模拟经营':['economy','world','progress'],'解谜探索':['world','controls','story'],'卡牌构筑':['combat','growth','items'],'叙事':['story','world','progress']};
      const selected=new Set(['experience','interface',...idea.genres.flatMap(genre=>byGenre[genre]??[])].map(id=>'system-'+id));
      container.querySelectorAll<HTMLInputElement>('.category-check input').forEach(input=>{input.checked=selected.has(input.value);});save();status.textContent='已勾选推荐分类，可以自由取消或补充；创建项目时才写入。';
    }
    if(button.hasAttribute('data-idea-regenerate')){
      // 用户明确要求重生时刷新心跳；网络失败保持未知，不能沿用过期连接。
      const before=area.value;
      void readConnections().then(value=>{connections=value;if(area.value===before)generate();}).catch(()=>{connections=undefined;if(area.value===before)generate();});
    }
    if(button.hasAttribute('data-idea-copy'))void copy(area,status);
    if(button.hasAttribute('data-idea-create')){save();const selected=[...container.querySelectorAll<HTMLInputElement>('.category-check input:checked')].map(input=>input.value);create({brief:ideaBrief(idea),categories:categoryPresets.filter(group=>selected.includes(group.id))});}
  });if(savedEdited){area.value=savedPrompt;label.textContent='正在读取连接状态…';}else generate();
}
