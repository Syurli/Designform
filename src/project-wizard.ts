import { presets } from '../shared/creative/presets';
import { composePrompt, emptyIdea, type GameIdea, type IntegrationInfo } from '../shared/prompts';
import { briefOptions, projectSingleSuggestions, projectIdeaBrief, restoreProjectIdea } from '../shared/project-brief';
import { projectAssemblies, assemblySelected, type AssemblyKey } from '../shared/project-assembly';
import type { LlmConnectionState, ProjectSnapshot } from '../shared/model';
import { listProjects, readConnections, request } from './project-client';
import { prepareDirectoryFields } from './edition';
import { h } from './creative/render';

/** 先选原有创作方向，再组合设想；私人草稿与公开简介、项目身份分别保存。 */
export async function projectWizard(open:(snapshot:ProjectSnapshot)=>Promise<void>|void){
  const library=await listProjects(),dialog=document.createElement('dialog');
  dialog.className='project-dialog desktop-task-dialog project-wizard';
  let step=0,busy=false,preset='game',idea=emptyIdea(),name='',directory=library.defaultDirectory,prompt='',edited=false;
  let facet='combination',expanded=false,feedback='选项均可跳过；组合会添加下方明确列出的词条。';
  // 每种方向独立保留拼装草稿，切换方向不混入其他领域，也不丢失此前填写内容。
  const directions:Record<string,{idea:GameIdea;prompt:string;edited:boolean}>={};
  let integration:IntegrationInfo={mode:'unknown'},connections:LlmConnectionState|undefined,completed:ProjectSnapshot|undefined;
  const requestId=crypto.randomUUID(),draftKey='cewen-project-wizard-draft';
  // 私人草稿逐字段恢复，切换方向和退回步骤均不清空已经填写的内容。
  try{
    const saved=JSON.parse(localStorage.getItem(draftKey)??'null');
    if(saved&&typeof saved==='object'){
      if(presets.some(p=>p.id===saved.preset))preset=saved.preset;
      idea=restoreProjectIdea(saved.idea);
      if(typeof saved.name==='string')name=saved.name;
      if(typeof saved.directory==='string')directory=saved.directory;
      if(saved.edited===true&&typeof saved.prompt==='string'){prompt=saved.prompt;edited=true;}
      for(const direction of presets){const draft=saved.directions?.[direction.id];if(draft&&typeof draft==='object')directions[direction.id]={idea:restoreProjectIdea(draft.idea),prompt:typeof draft.prompt==='string'?draft.prompt:'',edited:draft.edited===true};}
    }else{
      idea=restoreProjectIdea(JSON.parse(localStorage.getItem('cewen-game-idea')??'null'));
      const composer=JSON.parse(localStorage.getItem('cewen-creation-composer')??'null');
      if(composer?.edited===true&&typeof composer.prompt==='string'){prompt=composer.prompt;edited=true;}
    }
  }catch{/* 没有有效草稿时保留空设想。 */}
  const status=(text:string)=>{const node=dialog.querySelector('[role=status]');if(node)node.textContent=text;};
  const save=()=>{try{directions[preset]={idea:structuredClone(idea),prompt:edited?prompt:'',edited};localStorage.setItem(draftKey,JSON.stringify({preset,idea,name,directory,prompt:edited?prompt:'',edited,directions}));}catch{status('私人草稿暂无法保存，请复制保留。');}};
  const generate=()=>{prompt=composePrompt({scene:'start',integration,connections,extra:projectIdeaBrief(preset,idea)+'\n本轮协作方式：'+idea.approach});edited=false;save();};
  const updatePrompt=()=>{
    const area=dialog.querySelector<HTMLTextAreaElement>('[name=prompt]');if(area&&area.value!==prompt)area.value=prompt;
    const note=dialog.querySelector('[data-prompt-state]');if(note)note.textContent=edited?'已手动编辑 · 组合变化不会覆盖正文':'随设想自动更新 · 可直接编辑';
  };
  /** 局部更新控件，避免打字、心跳或选择词条造成焦点和滚动位置丢失。 */
  function changed(message:string){
    feedback=message;save();if(!edited)generate();updatePrompt();
    const note=dialog.querySelector('[data-assembly-feedback]');if(note)note.textContent=feedback;
    status(edited?'设想已保存，手改开场白已保留。需要同步组合时，可重新生成。':'');
  }
  const choices=(key:AssemblyKey,values:string[])=>[...new Set([...values,...idea[key]])].map(value=>'<button type="button" data-choice="'+key+'" data-value="'+h(value)+'" aria-pressed="'+idea[key].includes(value)+'">'+h(value)+'</button>').join('');
  /** 单值字段保留自定义输入，时长建议使用当前方向的语境。 */
  const field=(key:keyof GameIdea,label:string,values=projectSingleSuggestions[key])=>{
    const listId='wizard-suggestions-'+key;
    return '<label>'+h(label)+'<input data-field="'+key+'" '+(values?'list="'+listId+'" ':'')+'value="'+h(String(idea[key]??''))+'" placeholder="可跳过，也可自定义"/>'+(values?'<datalist id="'+listId+'">'+values.map(value=>'<option value="'+h(value)+'"></option>').join('')+'</datalist>':'')+'</label>';
  };
  const group=(key:AssemblyKey,label:string,values:string[],custom:keyof GameIdea)=>'<section class="wizard-facet-group"><h3>'+h(label)+' <small>可多选</small></h3><div class="idea-options">'+choices(key,values)+'</div>'+field(custom,'其他'+label)+'</section>';
  function facets(){
    const options=briefOptions[preset]??briefOptions.game,assembly=projectAssemblies[preset]??projectAssemblies.game;
    if(facet==='combination')return '<section class="wizard-suggestions"><h3>辅助组合 <small>仅添加所列词条，可继续修改</small></h3><div class="wizard-combinations">'+assembly.suggestions.map((item,index)=>'<button type="button" data-combination="'+index+'" aria-pressed="'+assemblySelected(idea,item)+'"><strong>'+h(item.title)+'</strong><small>'+h(item.detail)+'</small><span data-combination-mark>'+(assemblySelected(idea,item)?'已加入':'加入组合')+'</span></button>').join('')+'</div><button type="button" class="wizard-unsure" data-unsure>还没想清楚 · 先让 LLM 提问</button></section>';
    if(facet==='experience')return group('genres',assembly.labels.genre,options.genres,'customGenre')+group('goals','本轮目标',assembly.goals,'customGoal');
    if(facet==='content')return group('gameplay',assembly.labels.play,options.gameplay,'customPlay')+group('platforms',assembly.labels.platform,options.platforms,'customPlatform');
    return field('team','制作资源')+field('session',assembly.labels.session,assembly.sessions)+'<label>补充条件<textarea data-field="constraints" rows="2" placeholder="已有材料、技术条件、预算或暂不采用的方案">'+h(idea.constraints)+'</textarea></label>'+field('approach','协作方式');
  }
  function assemblyBody(){
    const assembly=projectAssemblies[preset]??projectAssemblies.game;
    return '<section class="wizard-assembly" aria-label="组合创作设想"><p class="wizard-guidance">'+h(assembly.hint)+'</p><label>一句话创作设想<textarea data-field="idea" rows="3" placeholder="'+h(assembly.placeholder)+'">'+h(idea.idea)+'</textarea></label><div class="wizard-facet-tabs" role="tablist" aria-label="设想细项">'+[['combination','辅助组合'],['experience','类型与目标'],['content','内容与载体'],['production','制作条件']].map(([id,label])=>'<button type="button" role="tab" id="wizard-tab-'+id+'" data-facet="'+id+'" aria-controls="wizard-facets" aria-selected="'+(facet===id)+'" tabindex="'+(facet===id?0:-1)+'">'+label+'</button>').join('')+'</div><div class="wizard-facets" id="wizard-facets" role="tabpanel" aria-labelledby="wizard-tab-'+facet+'">'+facets()+'</div><p data-assembly-feedback aria-live="polite">'+h(feedback)+'</p></section><section class="wizard-prompt" aria-label="协作开场白"><header><div><h3>协作开场白</h3><small data-prompt-state>'+(edited?'已手动编辑 · 组合变化不会覆盖正文':'随设想自动更新 · 可直接编辑')+'</small></div><button type="button" data-expand aria-expanded="'+expanded+'">'+(expanded?'返回组合':'展开预览')+'</button></header><textarea name="prompt" aria-label="协作开场白，可编辑" spellcheck="false">'+h(prompt)+'</textarea><div class="wizard-prompt-actions"><button type="button" data-regenerate>'+(edited?'重新生成（替换手改文本）':'重新生成')+'</button><button type="button" data-copy>复制开场白</button></div><small>创建后将带入真实项目身份。复制不会自动发送给 LLM。</small></section>';
  }
  function render(){
    dialog.dataset.step=String(step);dialog.classList.toggle('is-prompt-expanded',expanded&&step===1);
    const content=step===0?'<p>选择创作方向，下一步组合具体设想。所有模块始终可用。</p><div class="wizard-presets">'+[...presets.filter(p=>p.id!=='blank'),presets[0]].map(p=>'<label><input type="radio" name="preset" value="'+p.id+'" '+(preset===p.id?'checked':'')+'/><strong>'+h(p.title)+'</strong><small>'+h(p.description)+'</small></label>').join('')+'</div>':step===1?assemblyBody():'<label>项目名称<input name="name" value="'+h(name)+'" maxlength="100" autofocus/></label><label>项目保存父目录<input name="directory" value="'+h(directory)+'" required/></label><p>在所选目录创建独立项目；项目简介只保存你的设想。文档由后续创作按需要组织。</p>';
    dialog.innerHTML='<form><header><div><small>新建项目 · '+(preset==='blank'&&step===2?2:step+1)+' / '+(preset==='blank'?2:3)+(step===1?' · '+h(presets.find(p=>p.id===preset)?.title??''):'')+'</small><h2>'+['选择创作方向','组合创作设想','名称与保存位置'][step]+'</h2></div><button type="button" data-close aria-label="关闭">×</button></header><div class="task-body">'+content+'</div><p role="status" aria-live="polite"></p><footer><small>草稿自动保留</small><button type="button" data-back '+(step===0?'disabled':'')+'>上一步</button><button type="button" data-close>取消</button><button type="submit" class="primary-button">'+(step===2?'创建并进入项目':'下一步')+'</button></footer></form>';
    if(step===2)prepareDirectoryFields(dialog);
  }
  /** 真实项目身份独立保留，复制时追加，手改正文也不会丢失身份绑定。 */
  const identity=(snapshot:ProjectSnapshot)=>'本轮实际项目身份（以此为准，取代创建前文本中尚未创建的说明）：'+snapshot.project.name+'（'+snapshot.project.id+'）。当前修订：'+(snapshot.revisionLabel??snapshot.revision??'未记录')+'。'+(integration.mode==='local'?'本机项目目录：'+snapshot.project.path+'。':'网页版项目已创建；请经策问工具核对真实项目，不将网页虚拟路径当成本机目录。');
  function renderCompleted(snapshot:ProjectSnapshot){
    completed=snapshot;dialog.dataset.step='completed';dialog.classList.remove('is-prompt-expanded');
    const text=composePrompt({scene:'start',snapshot,integration,connections,extra:projectIdeaBrief(preset,idea)+'\n本轮协作方式：'+idea.approach+(edited?'\n\n以下为我在创建前手改的要求，原样保留；实际项目身份以当前快照与末尾身份说明为准：\n'+prompt:'')});
    dialog.innerHTML='<header><div><small>项目已创建</small><h2>复制本项目开场白</h2></div><button type="button" data-close aria-label="关闭">×</button></header><div class="task-body"><p>已经进入项目。复制下方文字给 LLM，即可围绕本项目起草初稿和关键问题。</p><label>本项目开场白 · 可编辑<textarea name="completed-prompt" rows="16" spellcheck="false">'+h(text)+'</textarea></label><p>'+h(identity(snapshot))+'</p></div><p role="status" aria-live="polite">复制不会自动发送给模型。</p><footer><button type="button" data-close>进入工作台</button><button type="button" class="primary-button" data-copy-final>复制本项目开场白</button></footer>';
  }
  const close=()=>{if(!busy){save();dialog.close();dialog.remove();}};
  const copy=(text:string,area:HTMLTextAreaElement|null,message:string)=>void navigator.clipboard.writeText(text).then(()=>status(message)).catch(()=>{if(area){area.value=text;area.focus();area.select();}status('复制未完成，已选中全文，请按 Ctrl+C。');});
  function syncSelections(){
    dialog.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button=>button.setAttribute('aria-pressed',String(idea[button.dataset.choice as AssemblyKey].includes(button.dataset.value!))));
    const assembly=projectAssemblies[preset]??projectAssemblies.game;
    dialog.querySelectorAll<HTMLButtonElement>('[data-combination]').forEach(button=>{const selected=assemblySelected(idea,assembly.suggestions[Number(button.dataset.combination)]);button.setAttribute('aria-pressed',String(selected));button.querySelector('[data-combination-mark]')!.textContent=selected?'已加入':'加入组合';});
    const regenerate=dialog.querySelector('[data-regenerate]');if(regenerate)regenerate.textContent=edited?'重新生成（替换手改文本）':'重新生成';
  }
  dialog.oninput=e=>{
    const input=e.target as HTMLInputElement;
    if(input.dataset.field){(idea as unknown as Record<string,unknown>)[input.dataset.field]=input.value;changed('设想已保存。');}
    if(input.name==='prompt'){prompt=input.value;edited=true;save();updatePrompt();syncSelections();status('手改内容已保存，后续选择会保留这份文字。');}
    if(input.name==='name')name=input.value;if(input.name==='directory')directory=input.value;save();
  };
  dialog.onchange=e=>{const input=e.target as HTMLInputElement;if(input.name==='preset'){
    save();preset=input.value;const draft=directions[preset];idea=draft?structuredClone(draft.idea):emptyIdea();prompt=draft?.prompt??'';edited=draft?.edited??false;
    facet='combination';expanded=false;feedback=draft?'已恢复此方向的创作草稿。':'选项均可跳过；组合会添加下方明确列出的词条。';save();
  }};
  /** 标签页使用方向键导航，切换时只重建当前分区。 */
  dialog.onkeydown=e=>{
    const tab=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-facet]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();const tabs=Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-facet]')),at=tabs.indexOf(tab);
    const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(at+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();
  };
  dialog.onclick=e=>{
    const button=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button||busy)return;
    if(button.hasAttribute('data-close')){close();return;}
    if(button.hasAttribute('data-back')){step=step===2&&preset==='blank'?0:step-1;render();return;}
    if(button.dataset.facet){facet=button.dataset.facet;dialog.querySelector('#wizard-facets')!.innerHTML=facets();dialog.querySelector('#wizard-facets')!.setAttribute('aria-labelledby','wizard-tab-'+facet);dialog.querySelectorAll<HTMLButtonElement>('[data-facet]').forEach(tab=>{const active=tab.dataset.facet===facet;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});return;}
    if(button.dataset.choice){const key=button.dataset.choice as AssemblyKey,value=button.dataset.value!,selected=idea[key].includes(value);idea[key]=selected?idea[key].filter(item=>item!==value):[...idea[key],value];changed((selected?'已移除：':'已加入：')+value);syncSelections();return;}
    if(button.dataset.combination!==undefined){
      const item=(projectAssemblies[preset]??projectAssemblies.game).suggestions[Number(button.dataset.combination)],already=assemblySelected(idea,item);
      for(const [key,values] of Object.entries(item.values))idea[key as AssemblyKey]=[...new Set([...idea[key as AssemblyKey],...values])];
      changed((already?'组合已包含：':'已加入「'+item.title+'」：')+item.detail+'。可在下方细项逐项移除。');
      dialog.querySelector('#wizard-facets')!.innerHTML=facets();syncSelections();return;
    }
    if(button.hasAttribute('data-unsure')){idea.approach='先问我关键问题';changed('协作方式已设为「先问我关键问题」，已有设想和选项已保留。');const input=dialog.querySelector<HTMLInputElement>('[data-field=approach]');if(input)input.value=idea.approach;return;}
    if(button.hasAttribute('data-expand')){expanded=!expanded;dialog.classList.toggle('is-prompt-expanded',expanded);button.textContent=expanded?'返回组合':'展开预览';button.setAttribute('aria-expanded',String(expanded));return;}
    if(button.hasAttribute('data-regenerate')){generate();updatePrompt();syncSelections();status('已按当前设想重新生成开场白。');return;}
    if(button.hasAttribute('data-copy')){copy(prompt,dialog.querySelector('[name=prompt]'),'开场白已复制；请发送给你使用的 LLM。');return;}
    if(button.hasAttribute('data-copy-final')&&completed){const area=dialog.querySelector<HTMLTextAreaElement>('[name=completed-prompt]')!,binding=identity(completed),text=area.value.trimEnd().endsWith(binding)?area.value:area.value+'\n\n'+binding;copy(text,area,'本项目开场白已复制；请发送给你使用的 LLM。');}
  };
  dialog.oncancel=e=>{e.preventDefault();close();};
  dialog.onsubmit=e=>{
    e.preventDefault();if(busy)return;
    if(step<2){if(!edited)generate();step=step===0&&preset==='blank'?2:step+1;render();return;}
    // 目录选择器可能直接赋值，提交前读取表单中的最终授权目录。
    const data=new FormData(dialog.querySelector('form')!);name=String(data.get('name')??name).trim()||'未命名项目';directory=String(data.get('directory')??directory);save();busy=true;
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true);status('正在创建项目…');
    void request<ProjectSnapshot>('/api/creative-project',{name,directory,preset,requestId,brief:preset==='blank'?'':projectIdeaBrief(preset,idea),sample:false,demo:false}).then(async snapshot=>{
      await open(snapshot);clearInterval(timer);
      if(preset==='blank'){dialog.close();dialog.remove();}else{if(!dialog.isConnected)document.body.append(dialog);renderCompleted(snapshot);if(!dialog.open)dialog.showModal();}
    }).catch(error=>status(error.message+'。输入已保留，可以重试。')).finally(()=>{busy=false;dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=false);});
  };
  render();document.body.append(dialog);dialog.showModal();
  /** 连接心跳只更新未经手改的正文，不重建正在输入的面板。 */
  const refresh=async()=>{try{connections=await readConnections();}catch{connections=undefined;}if(dialog.open&&!completed&&!edited){generate();updatePrompt();}};
  void Promise.allSettled([request<IntegrationInfo>('/api/integration'),readConnections()]).then(([info,state])=>{if(!dialog.open||completed)return;if(info.status==='fulfilled')integration=info.value;if(state.status==='fulfilled')connections=state.value;if(!edited){generate();updatePrompt();}});
  const timer=setInterval(()=>{if(!document.hidden)void refresh();},4000);dialog.addEventListener('close',()=>clearInterval(timer),{once:true});
}
