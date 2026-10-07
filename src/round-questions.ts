import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { inquiry, questionAvailable, answerQuestion, questionDisplayTitle, questionDisplayBackground } from '../shared/inquiry';
import { readHeader } from '../shared/markdown';
import { isTransientProject } from '../shared/transient';
import { answerHandoff, questionRoundKey, type AnswerHandoff } from '../shared/answer-handoff';
import { buildCreativeIndex } from '../shared/creative/content';
import { resolveAnchor, hasAnchorTarget } from '../shared/creative/anchors';
import { relatedQuestions } from './creative/questions';
import { projectAction } from './project-client';
import { copyAnswerOpening, openCollaboration } from './prompt-panel';
import { ProjectQuestionDirectory } from './project-question-directory';
import { questionDocuments, questionSources, visibleProjectQuestions, type QuestionDirectoryState, type QuestionStateInfo } from './project-question-model';
import { h } from './creative/render';
import './round-questions.css';

interface Draft { hash:string; text:string; choices:string[]; action:string; questionText?:string; basis?:string }
interface Session {
  round:string; question:string; summary:boolean; summaryMode?:'round'|'all';
  directory?:QuestionDirectoryState; receipt?:AnswerHandoff; receipts?:Record<string,AnswerHandoff>;
  /** 复核及已提交来源基准仅属个人记录，不改写问题或历史回答。 */
  reviewedBases?:Record<string,string>; submittedBases?:Record<string,string>;
}
interface Options {
  apply:(s:ProjectSnapshot)=>void; back:()=>void; source:(id:string)=>void;
  saveAs:()=>Promise<boolean>; hasUnsaved:()=>boolean;
  initialQuestionId?:string; initialDocumentId?:string;
  importQuestions?:()=>void;
  onStateChange?:(stats:{pending:number;drafts:number})=>void;
}
/** 临时示例仅保留内存；项目策问和正文阅读使用不同的个人会话键。 */
const memory=new Map<string,{drafts:Record<string,Draft>;sessions:Record<string,Session>}>();
export function forgetRoundSession(projectId:string){memory.delete(projectId);}
const emptyDirectory=():QuestionDirectoryState=>({group:'',documentId:'',questionId:'',filter:'all',query:'',includeArchived:false});
/** 已提交摘要从原始回答解析，不用空白草稿替代用户此前原话。 */
function latestAnswer(doc:ProjectDocument){
  const text=inquiry(doc).previous.split('### 回答 ').slice(1).at(-1);
  if(!text)return undefined;
  return {choices:text.split('\n').filter(s=>/^  - /.test(s)&&!s.includes('无预设选项')).map(s=>s.slice(4)),
    text:text.split('\n').filter(s=>s.startsWith('>')).map(s=>s.replace(/^> ?/,'')).join('\n').replace(/^未填写自定义文本。$/,''),
    action:/- 作答方式：([^\n]+)/.exec(text)?.[1]??'回答'};
}
function filled(draft?:Draft){return !!draft&&(!!draft.text.trim()||!!draft.choices.length||!!draft.action);}

/** 项目问题按稳定身份共用草稿；浏览范围可以跨轮，服务提交始终只含当前轮。 */
export class RoundQuestions {
  private drafts:Record<string,Draft>;
  private session:Session;
  private directory:ProjectQuestionDirectory;
  private busy=false;
  private displayed?:ProjectDocument;
  private requestId=''; private signature='';
  private banner=''; private disposed=false; private composing=false;
  private pendingNavigation?:()=>void;
  private basisCache=new Map<string,string>();
  private creativeCache?:{snapshot:ProjectSnapshot;index:ReturnType<typeof buildCreativeIndex>};
  private sourceWarnings=new Map<string,string>();
  constructor(private host:HTMLElement,private nav:HTMLElement,private snapshot:ProjectSnapshot,private documentId:string,private options:Options){
    const id=snapshot.project.id;let stored=memory.get(id);
    if(!stored){
      stored={drafts:{},sessions:{}};
      if(!isTransientProject(id))try{
        const drafts=JSON.parse(localStorage.getItem('cewen-answers-090:'+id)??'{}');
        for(const [key,value] of Object.entries(drafts)){
          const d=value as Draft;
          if(d&&typeof d.hash==='string'&&typeof d.text==='string'&&typeof d.action==='string'&&Array.isArray(d.choices)&&d.choices.every(c=>typeof c==='string'))stored.drafts[key]=d;
        }
        const sessions=JSON.parse(localStorage.getItem('cewen-round-sessions:'+id)??'{}');
        // 损坏的个人会话不能阻断正式项目；正文旧会话不迁入项目策问范围。
        if(sessions&&typeof sessions==='object')for(const [key,value] of Object.entries(sessions)){
          const s=value as Session;
          if(s&&typeof s.round==='string'&&typeof s.question==='string'&&typeof s.summary==='boolean')stored.sessions[key]=s;
        }
      }catch{/* 损坏缓存不覆盖正式答案。 */}
      memory.set(id,stored);
    }
    this.drafts=stored.drafts;
    const sessionKey=documentId||'__project__';
    this.session=stored.sessions[sessionKey]??{round:'',question:'',summary:false};
    stored.sessions[sessionKey]=this.session;
    const saved=this.session.directory,defaults=emptyDirectory();
    this.session.directory={...defaults,group:typeof saved?.group==='string'?saved.group:'',documentId:typeof saved?.documentId==='string'?saved.documentId:'',
      questionId:this.session.question,query:typeof saved?.query==='string'?saved.query:'',includeArchived:saved?.includeArchived===true,
      filter:saved&&['all','pending','draft','submitted','review'].includes(saved.filter)?saved.filter:'all'};
    this.rememberSubmittedBases();this.directory=this.createDirectory();
    this.chooseInitial();
    if(options.initialQuestionId&&this.all().some(q=>q.id===options.initialQuestionId))this.selectQuestion(options.initialQuestionId);
    else if(options.initialDocumentId)this.setScope('',options.initialDocumentId);
    this.bind();this.render();
  }
  private state(){return this.session.directory!;}
  /** 同一题的多来源只影响定位，不能重复草稿、计数或提交。 */
  private all(){return [...new Map(this.snapshot.documents.filter(d=>d.type==='question').map(d=>[d.id,d])).values()];}
  private round(){return this.all().filter(d=>questionRoundKey(d)===this.session.round&&(this.state().includeArchived||d.status!=='archived'));}
  private current(){return this.all().find(d=>d.id===this.session.question);}
  private visible(records=this.records()){
    const questions=visibleProjectQuestions(this.snapshot,this.state(),records);
    return this.documentId?questions.filter(q=>relatedQuestions(this.snapshot,this.documentId).some(d=>d.id===q.id)):questions;
  }
  /** 每轮独立保留交接收据，不能借用另一轮实际提交的开场白。 */
  private receipt(){
    const r=this.session.receipts?.[this.session.round]??this.session.receipt;
    return r?.projectId===this.snapshot.project.id&&Array.isArray(r.questions)&&r.questions.length&&r.questions.every(q=>JSON.stringify([q.questId??'',q.roundId??q.round])===this.session.round)?r:undefined;
  }
  private preferred(questions:ProjectDocument[]){
    const docs=this.projected(),records=this.records(docs);
    return questions.find(q=>!latestAnswer(q)&&!filled(this.drafts[q.id])&&questionAvailable(q,docs).active&&records[q.id]?.status!=='review')
      ??questions.find(q=>filled(this.drafts[q.id]))??questions[0];
  }
  private chooseInitial(){
    // 已显示题不因新题或输入后的状态筛选变化跳走；只有题目移除才重新选择。
    if(this.current()){
      if(!this.session.summary)this.session.round=questionRoundKey(this.current()!);
      return;
    }
    const first=this.preferred(this.visible());
    if(first)this.selectQuestion(first.id);
    else {this.session.question='';this.state().questionId='';if(!this.round().length)this.session.round='';}
  }
  private selectQuestion(id:string){
    const q=this.all().find(d=>d.id===id);if(!q)return;
    const previous=this.current();
    if(previous&&previous.id!==id){
      const changedRound=questionRoundKey(previous)!==questionRoundKey(q),changedSources=JSON.stringify(questionSources(this.snapshot,previous))!==JSON.stringify(questionSources(this.snapshot,q));
      if(changedRound||changedSources)this.banner='上一题的回答已在本机保留。';
    }
    this.session.question=id;this.session.round=questionRoundKey(q);this.session.summary=false;
    this.state().questionId=id;
  }
  private setScope(group:string,documentId:string){
    this.state().group=group;this.state().documentId=documentId;
    const first=this.preferred(this.visible());
    if(first)this.selectQuestion(first.id);else{this.session.question='';this.state().questionId='';this.session.summary=false;}
  }
  private save(){
    if(isTransientProject(this.snapshot.project.id))return;
    try{
      localStorage.setItem('cewen-answers-090:'+this.snapshot.project.id,JSON.stringify(this.drafts));
      localStorage.setItem('cewen-round-sessions:'+this.snapshot.project.id,JSON.stringify(memory.get(this.snapshot.project.id)?.sessions??{}));
    }catch{this.banner='本机草稿缓存不可用，当前会话仍保留，请及时到汇总复制开场白并保存回答。';}
  }
  private dependency(doc:ProjectDocument){const m=readHeader(doc.text).metadata;return (m.when as {questionId?:string})?.questionId??(typeof m.follows==='string'?m.follows:'');}
  /** 输入只改变个人草稿，创作对象索引仅在公开快照替换时重新解析。 */
  private creativeIndex(){
    if(this.creativeCache?.snapshot!==this.snapshot)this.creativeCache={snapshot:this.snapshot,index:buildCreativeIndex(this.snapshot)};
    return this.creativeCache.index;
  }
  private basis(doc:ProjectDocument){
    const cached=this.basisCache.get(doc.id);if(cached)return cached;
    const id=this.dependency(doc),prev=this.all().find(d=>d.id===id),draft=this.drafts[id],meta=readHeader(doc.text).metadata;
    const objects=this.creativeIndex().objects;
    const objectIds=[...(Array.isArray(meta.objectTargets)?meta.objectTargets.filter((v):v is string=>typeof v==='string'):[]),...((meta.anchor as {objectId?:string})?.objectId?[(meta.anchor as {objectId:string}).objectId]:[])];
    // 来源文档与对象身份都参与基准：对象移除、重定位和正文修改均需复核旧草稿。
    const basis=JSON.stringify([doc.hash,id,prev?.hash??'',draft?[draft.hash,draft.choices,draft.text,draft.action]:null,
      questionSources(this.snapshot,doc).map(sourceId=>[sourceId,this.snapshot.documents.find(d=>d.id===sourceId)?.hash??'missing']),
      objectIds.map(objectId=>[objectId,objects.filter(o=>o.object.id===objectId).map(o=>[o.documentId,o.hash])]),meta.anchor??null]);
    this.basisCache.set(doc.id,basis);return basis;
  }
  /** 既有回答第一次出现时仅登记此刻基准，不能推断或声称还原旧回答的历史来源。 */
  private rememberSubmittedBases(){
    this.session.submittedBases??={};
    for(const doc of this.all())if(latestAnswer(doc)&&typeof this.session.submittedBases[doc.id]!=='string')this.session.submittedBases[doc.id]=this.basis(doc);
  }
  private stale(doc:ProjectDocument){const draft=this.drafts[doc.id];return !!draft&&(draft.hash!==doc.hash||draft.basis!==undefined&&draft.basis!==this.basis(doc));}
  private sourceWarning(doc:ProjectDocument){
    const cached=this.sourceWarnings.get(doc.id);if(cached!==undefined)return cached;
    const remember=(reason:string)=>{this.sourceWarnings.set(doc.id,reason);return reason;};
    const valid=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    const missing=questionSources(this.snapshot,doc).filter(id=>!valid.has(id));
    if(missing.length)return remember(`来源已失效：${missing.join('、')}；问题与原始回答保留。`);
    const meta=readHeader(doc.text).metadata;
    if(hasAnchorTarget(meta.anchor)){
      const resolved=resolveAnchor(this.snapshot,meta.anchor);
      if(resolved.state==='missing'||resolved.state==='ambiguous')return remember(resolved.reason);
      const anchor=meta.anchor as {documentHash?:string};
      if(anchor.documentHash&&this.snapshot.documents.find(d=>d.id===resolved.documentId)?.hash!==anchor.documentHash)return remember('来源正文已变化，请核对当前来源。');
    }
    return remember('');
  }
  private sourceReason(doc:ProjectDocument){
    // 来源诊断放在折叠依据中；来源暂时不可定位不妨碍用户表达对问题本身的回答。
    const saved=this.session.submittedBases?.[doc.id];
    if(saved&&saved!==this.basis(doc))return '已保存回答的来源或前题已变化，请核对后改答。';
    return '';
  }
  private reviewReason(doc:ProjectDocument){
    if(this.stale(doc))return '题目、来源或前题回答已变化，旧草稿保留。';
    const reason=this.sourceReason(doc);
    return reason&&this.session.reviewedBases?.[doc.id]!==this.basis(doc)?reason:'';
  }
  /** 条件预显只投影当前轮草稿；其他轮草稿不会因当前轮提交而自动生效。 */
  private projected(selected?:Set<string>){
    const docs=this.snapshot.documents.map(d=>({...d}));
    const pending=this.round().filter(d=>(!selected||selected.has(d.id))&&filled(this.drafts[d.id])&&!this.stale(d)&&!this.reviewReason(d));
    for(let pass=0;pass<=pending.length;pass++)for(const doc of pending){
      const draft=this.drafts[doc.id],target=docs.find(d=>d.id===doc.id)!;
      if(!questionAvailable(doc,docs).active)continue;
      target.text=answerQuestion(doc,{id:'draft-preview',choices:draft.choices,text:draft.text,action:draft.action||'回答',revision:this.snapshot.revision});
    }
    return docs;
  }
  private records(docs=this.projected()):Record<string,QuestionStateInfo>{
    return Object.fromEntries(this.all().map(doc=>{
      const available=questionAvailable(doc,docs),draft=this.drafts[doc.id],review=this.reviewReason(doc);
      const saved=latestAnswer(doc),status:QuestionStateInfo['status']=review||saved&&!available.active?'review':filled(draft)?draft!.action==='暂缓'?'deferred':draft!.action==='前提不成立'?'premise':'draft':saved?saved.action==='暂缓'?'deferred':saved.action==='前提不成立'?'premise':'submitted':'pending';
      return [doc.id,{id:doc.id,status,sourceIds:questionSources(this.snapshot,doc),blocked:!available.active,reason:[review,!available.active?available.reason:''].filter(Boolean).join('；')}];
    }));
  }
  private status(doc:ProjectDocument,record=this.records()[doc.id]){
    const labels:Record<QuestionStateInfo['status'],string>={review:'题目已更新',draft:'已回答',deferred:'暂缓',premise:'题目有问题',submitted:'已保存',pending:'待回答'};
    return `${labels[record.status]}${record.blocked?' · 条件尚未满足':''}`;
  }
  /** 公开收尾入口供模式退出使用，只保存草稿，不销毁会话或提交。 */
  captureDraft(){this.capture(false);this.save();this.notifyStats();}
  private capture(updateNav=true,acceptCurrent=false){
    const form=this.host.querySelector<HTMLFormElement>('[data-round-form]'),doc=this.displayed;
    if(!form||!doc||this.busy||this.snapshot.historical)return;
    // 禁用条件题的 FormData 不含输入，不能据此删掉此前的草稿。
    if(form.querySelector('fieldset[disabled]'))return;
    const data=new FormData(form),choices=data.getAll('choice').map(String),text=String(data.get('text')??'');
    let action=String(data.get('action')??'');
    const old=this.drafts[doc.id],current=this.current(),accept=acceptCurrent&&current?.hash===doc.hash;
    // 明确修改当前表单即更新作答基准；仅切页或失焦时保留旧题的原始选择。
    if(old&&!accept&&old.hash!==doc.hash)for(const choice of old.choices)if(!inquiry(doc).options.includes(choice)&&!choices.includes(choice))choices.push(choice);
    // 修改旧暂缓记录后，填写内容自动恢复为回答；问题反馈标记仍由独立按钮控制。
    if(accept&&action==='暂缓'&&(choices.length||text.trim())){
      action='';const field=form.querySelector<HTMLInputElement>('[name=action]');if(field)field.value='';
    }
    // 清空已保存的旧回答表示本次暂缓，不能删除草稿后悄悄回显旧答案。
    if(!choices.length&&!text.trim()&&!action&&latestAnswer(doc))action='暂缓';
    if(choices.length||text.trim()||action)this.drafts[doc.id]={hash:accept?doc.hash:old?.hash??doc.hash,choices,text,action,questionText:accept?doc.text:old?.questionText??doc.text,basis:accept?this.basis(doc):old?.basis??this.basis(doc)};
    else delete this.drafts[doc.id];
    if(accept){this.session.reviewedBases??={};this.session.reviewedBases[doc.id]=this.basis(doc);}
    this.basisCache.clear();this.save();this.updateProgress();if(updateNav)this.renderNav();
  }
  private navigate(action:()=>void){
    if(this.busy)return;
    // 中文组合结束后再替换表单，避免切目录吞掉输入法尚未落字的内容。
    if(this.composing){
      const previous=this.pendingNavigation;
      this.pendingNavigation=previous?()=>{previous();action();}:action;
      return;
    }
    // 先暂存而不重画目录，避免搜索回调中短暂恢复旧query，移动输入光标。
    this.capture(false);action();
  }
  private createDirectory(){
    return new ProjectQuestionDirectory(this.nav,{
      onScope:(group,documentId)=>this.navigate(()=>{this.setScope(group,documentId);this.render();}),
      onQuestion:id=>this.navigate(()=>{this.selectQuestion(id);this.render();}),
      onFilter:filter=>this.navigate(()=>{this.state().filter=filter;this.reselectScope();}),
      onQuery:query=>this.navigate(()=>{this.state().query=query;this.reselectScope();}),
      onArchived:show=>this.navigate(()=>{this.state().includeArchived=show;this.reselectScope();}),
      onSummary:()=>this.navigate(()=>{this.session.summary=true;this.session.summaryMode='round';this.render();}),
      onBack:()=>this.navigate(()=>this.options.back())
    });
  }
  private reselectScope(){
    const visible=this.visible();
    if(!visible.some(d=>d.id===this.session.question)){
      const first=this.preferred(visible);if(first)this.selectQuestion(first.id);else{this.session.question='';this.state().questionId='';}
    }
    this.session.summary=false;this.render();
  }
  private renderNav(){
    if(this.disposed)return;
    const records=this.records();this.directory.render(this.snapshot,this.state(),records);
    this.notifyStats(records);
  }
  private notifyStats(records=this.records()){
    this.options.onStateChange?.({pending:this.all().filter(q=>q.status!=='archived'&&['pending','deferred','review'].includes(records[q.id]?.status)).length,drafts:Object.values(this.drafts).filter(filled).length});
  }
  private sourceLabel(doc:ProjectDocument){
    return questionSources(this.snapshot,doc).map(id=>this.snapshot.documents.find(d=>d.id===id)?.title??`失效来源 ${id}`).join('、')||'未关联问题';
  }
  /** 只替换计数字符，不重画正在输入的表单和中文输入法焦点。 */
  private updateProgress(){
    const round=this.round(),count=round.filter(d=>{const a=this.drafts[d.id]??latestAnswer(d);return a&&a.action!=='暂缓'&&a.action!=='前提不成立'&&(a.choices.length||a.text.trim());}).length;
    const progress=this.host.querySelector<HTMLElement>('[data-answer-progress]');
    if(progress)progress.textContent=`已回答 ${count} / ${round.length} 题`;
  }
  private render(){
    if(this.disposed)return;
    this.chooseInitial();this.save();const doc=this.current(),round=this.round();this.displayed=undefined;
    if(!doc&&!this.session.summary){
      const hasQuestions=this.all().length>0;
      this.host.innerHTML=`<div class="round-empty"><h2>${hasQuestions?'当前范围没有问题':'这个项目还没有问题'}</h2><p>${hasQuestions?'切换全部问题、状态筛选或清除搜索即可继续；回答草稿仍然保留。':'可预览并编辑项目提问开场白，让 LLM 围绕本项目提出一轮明确问题；已有问题可从项目导入入口加入。'}</p><p class="round-feedback" role="status">${h(this.banner)}</p>${hasQuestions?'<button data-all-questions>查看全部问题</button>':''}<button data-start>生成项目提问开场白</button>${this.options.importQuestions?'<button data-import-questions>导入已有问题</button>':''}<button data-all-drafts>全部草稿</button><button data-back>返回策划案</button></div>`;
      this.renderNav();return;
    }
    const count=round.filter(d=>{const a=this.drafts[d.id]??latestAnswer(d);return a&&a.action!=='暂缓'&&a.action!=='前提不成立'&&(a.choices.length||a.text.trim());}).length;
    this.host.innerHTML=`<header class="round-heading"><button data-back>← 返回策划案</button><div><strong>策问</strong><small data-answer-progress>已回答 ${count} / ${round.length} 题</small></div><button data-summary>本轮汇总</button><button data-all-drafts>其他轮回答</button></header><p class="round-feedback" role="status">${h(this.banner)}</p><div class="round-content"></div>`;
    const content=this.host.querySelector<HTMLElement>('.round-content')!;
    if(this.session.summary){if(this.session.summaryMode==='all')this.allDrafts(content);else this.summary(content);}else if(doc)this.question(content,doc);
    this.renderNav();
  }
  /** 作答区只放问题、必要背景与回答，协作来源和历史集中在折叠区。 */
  private question(content:HTMLElement,doc:ProjectDocument){
    const q=inquiry(doc),draft=this.drafts[doc.id],saved=latestAnswer(doc),answer=draft??saved;
    const available=questionAvailable(doc,this.projected()),visible=this.visible(),index=visible.findIndex(d=>d.id===doc.id),review=this.reviewReason(doc);
    this.displayed=doc;
    const ids=questionSources(this.snapshot,doc),validSources=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    const background=questionDisplayBackground(q.background),issue=answer?.action==='前提不成立';
    content.innerHTML=`<article class="round-question">
      <small>${index>=0?`第 ${index+1} / ${visible.length} 题`:''}</small>
      <h2>${h(questionDisplayTitle(q.title))}</h2>
      ${background?`<p class="round-background">${h(background)}</p>`:''}
      ${review?`<details class="round-review"><summary>题目已更新，修改回答即可使用当前题目</summary><p>${h(review)}</p>${draft?`<pre>${h(draft.questionText??'')}</pre><p>此前选择：${h(draft.choices.join('；')||'无')}</p>`:''}<button data-reviewed>保留当前回答</button></details>`:''}
      ${!available.active?`<p class="round-condition">${h(available.reason)}</p>`:''}
      ${!draft&&saved?'<p class="round-saved-answer">已保存的回答 <button data-revise>修改回答</button></p>':''}
      <form data-round-form><fieldset ${this.snapshot.historical||!available.active||!draft&&saved?'disabled':''}>
        ${q.options.map(option=>`<label class="round-option"><input type="${q.multiple?'checkbox':'radio'}" name="choice" value="${h(option)}" ${answer?.choices.includes(option)?'checked':''}/><span>${h(option)}</span></label>`).join('')}
        <button type="button" class="round-text-button" data-clear-choice>清除选择</button>
        <label>我的回答 / 补充理由<textarea name="text" rows="4" placeholder="直接写下你的想法；不填写的题目可以稍后再答。">${h(answer?.text??'')}</textarea></label>
        <input type="hidden" name="action" value="${h(draft?.action??'')}"/>
        <div class="round-answer-actions"><button type="button" data-question-issue aria-pressed="${issue}">${issue?'已标记题目有问题 · 取消':'题目有问题'}</button>${issue?'<span>可在回答中说明需要调整的地方。</span>':''}</div>
      </fieldset></form>
      <details class="round-source"><summary>查看依据与此前回答</summary>
        ${ids.map(id=>{const source=this.snapshot.documents.find(d=>d.id===id);return source&&validSources.has(id)?`<button data-source="${h(id)}">${h(source.title)}</button><pre>${h(readHeader(source.text).body.slice(0,5000))}</pre>`:`<p>关联记录暂不可定位：${h(id)}</p>`;}).join('')}
        ${this.sourceWarning(doc)?`<p>${h(this.sourceWarning(doc))}</p>`:''}
        <h4>此前回答</h4><pre>${h(q.previous)}</pre>
        ${!['','尚未形成。'].includes(q.interpretation)?`<h4>分析</h4><pre>${h(q.interpretation)}</pre>`:''}
        ${!['','尚未采纳。'].includes(q.decision)?`<h4>决定记录</h4><pre>${h(q.decision)}</pre>`:''}
      </details>
      <footer class="round-navigation"><button data-previous ${index<=0?'disabled':''}>上一题</button><span>回答自动在本机保留</span><button class="primary-button" data-next>${index>=visible.length-1?'查看本轮汇总':'下一题'}</button></footer>
    </article>`;
  }
  /** 一轮结果自动收集已填写回答，用户无需再次逐题选择。 */
  private summary(content:HTMLElement){
    const round=this.round(),groups=new Map<string,ProjectDocument[]>(),docs=this.projected();
    const valid=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    for(const doc of round){const source=questionSources(this.snapshot,doc).find(id=>valid.has(id))??'';groups.set(source,[...(groups.get(source)??[]),doc]);}
    const result=(doc:ProjectDocument)=>this.drafts[doc.id]??latestAnswer(doc);
    const answered=round.filter(doc=>{const a=result(doc);return a&&a.action!=='暂缓'&&a.action!=='前提不成立'&&(a.choices.length||a.text.trim());}).length;
    const issues=round.filter(doc=>result(doc)?.action==='前提不成立').length;
    // 已保存回答改成全数暂缓也需要保存交接；全新且完全空白的一轮不生成虚假收据。
    const canHandoff=round.some(doc=>filled(this.drafts[doc.id])||latestAnswer(doc));
    let index=0;
    content.innerHTML=`<div class="round-summary-tools"><h2>本轮回答汇总</h2><button data-all-drafts>其他轮回答</button></div>
      <p class="round-result-count">已回答 ${answered} 题 · 暂缓 ${round.length-answered-issues} 题${issues?` · 题目有问题 ${issues} 题`:''}</p>
      <div class="round-summary">${[...groups].map(([source,questions])=>`<section class="round-summary-group"><h3>${h(source?this.snapshot.documents.find(d=>d.id===source)?.title??'其他问题':'其他问题')}</h3>${questions.map(doc=>{
        const answer=result(doc),available=questionAvailable(doc,docs),review=this.reviewReason(doc);
        return `<article><header><strong>${++index}. ${h(questionDisplayTitle(doc.title))}</strong><button data-question="${h(doc.id)}">修改回答</button></header>
          ${answer?.action==='前提不成立'?'<small>题目有问题</small>':''}
          ${answer?.choices.length?`<p>${h(answer.choices.join('；'))}</p>`:''}
          ${answer?.text?`<p class="round-verbatim">${h(answer.text)}</p>`:''}
          ${!answer||answer.action==='暂缓'?'<p class="quiet">暂缓，稍后再答</p>':''}
          ${review||!available.active?`<small class="round-review-note">${h(review?'题目已更新，请返回修改回答':available.reason)}</small>`:''}
        </article>`;
      }).join('')}</section>`).join('')}</div>
      <section class="round-handoff"><h3>交给 LLM 分析</h3>
        <p>复制时将本轮回答保存到项目，再把开场白发给你使用的 LLM。</p>
        <button data-handoff data-copy-opening class="primary-button" ${this.busy||this.snapshot.historical||!canHandoff?'disabled':''}>${this.busy?'正在保存回答…':'复制开场白，请 LLM 分析'}</button>
        <button data-handoff ${this.busy||this.snapshot.historical||!canHandoff?'disabled':''}>预览 / 编辑开场白</button>
        ${this.options.hasUnsaved()?'<small>策划正文还有未保存修改，分析将使用已保存正文。</small>':''}
      </section>`;
  }
  private allDrafts(content:HTMLElement){
    const groups=new Map<string,ProjectDocument[]>(),records=this.records();
    for(const q of this.all().filter(d=>questionRoundKey(d)!==this.session.round&&filled(this.drafts[d.id]))){const key=questionRoundKey(q);groups.set(key,[...(groups.get(key)??[]),q]);}
    const missing=Object.keys(this.drafts).filter(id=>filled(this.drafts[id])&&!this.all().some(q=>q.id===id));
    content.innerHTML=`<div class="round-summary-tools"><h2>其他轮回答</h2><button data-summary>返回本轮汇总</button></div><p>按轮次继续回答，完成后到该轮汇总复制分析开场白。</p>${[...groups].map(([key,questions])=>`<section class="round-draft-group"><header><h3>${h(inquiry(questions[0]).round)} · ${questions.length} 份草稿</h3><button data-draft-round="${h(key)}">打开该轮汇总</button></header>${questions.map(q=>`<button class="round-draft-question" data-question="${h(q.id)}"><strong>${h(q.title)}</strong><small>${h(this.sourceLabel(q))} · ${this.status(q,records[q.id])}</small></button>`).join('')}</section>`).join('')||'<p>没有其他回答草稿。</p>'}${missing.length?`<section class="round-warning"><h3>题目已移除，草稿仍保留</h3>${missing.map(id=>`<details><summary>${h(id)} · 待复核</summary><pre>${h(this.drafts[id].questionText??'旧题正文未缓存')}</pre><p>${h(this.drafts[id].choices.join('；'))}</p><p class="round-verbatim">${h(this.drafts[id].text)}</p></details>`).join('')}</section>`:''}`;
  }
  private compositionStart=()=>{this.composing=true;};
  private compositionEnd=()=>{
    this.composing=false;this.capture(true,true);const action=this.pendingNavigation;this.pendingNavigation=undefined;
    if(action)queueMicrotask(()=>{if(!this.disposed)this.navigate(action);});
  };
  private bind(){
    this.host.addEventListener('compositionstart',this.compositionStart);this.host.addEventListener('compositionend',this.compositionEnd);
    this.host.oninput=()=>this.capture(true,true);
    // 点击目录会先让文本框失焦；此时不能在按下与抬起之间替换目标按钮。
    // 输入事件已更新目录状态，失焦仅补存最终值与数量，不重绘导航。
    this.host.onchange=()=>{this.capture(false,true);this.notifyStats();};
    this.host.onsubmit=e=>e.preventDefault();
    this.host.onclick=e=>{
      const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b||b.disabled||this.busy)return;
      const run=(fn:()=>Promise<unknown>)=>void fn().catch(err=>{this.banner=err instanceof Error?err.message:String(err);this.feedback();});
      if(b.hasAttribute('data-back')){this.navigate(()=>this.options.back());return;}
      if(b.dataset.source){this.navigate(()=>this.options.source(b.dataset.source!));return;}
      if(b.hasAttribute('data-start')){this.capture();run(()=>this.start());return;}
      if(b.hasAttribute('data-import-questions')){this.navigate(()=>this.options.importQuestions?.());return;}
      if(b.hasAttribute('data-clear-choice')){this.host.querySelectorAll<HTMLInputElement>('[name=choice]').forEach(input=>input.checked=false);this.capture(true,true);return;}
      if(b.hasAttribute('data-question-issue')){
        const action=this.host.querySelector<HTMLInputElement>('[name=action]');if(!action)return;
        action.value=action.value==='前提不成立'?'':'前提不成立';this.capture(true,true);this.render();return;
      }
      if(b.hasAttribute('data-reviewed')){this.navigate(()=>{
        const doc=this.current();if(!doc)return;const draft=this.drafts[doc.id];
        if(draft){draft.hash=doc.hash;draft.questionText=doc.text;draft.choices=draft.choices.filter(c=>inquiry(doc).options.includes(c));this.basisCache.clear();draft.basis=this.basis(doc);}
        this.session.reviewedBases??={};this.session.reviewedBases[doc.id]=this.basis(doc);this.save();this.render();
      });return;}
      if(b.hasAttribute('data-revise')){if(this.snapshot.historical)return;this.navigate(()=>{
        const doc=this.current();if(!doc)return;const answer=latestAnswer(doc);
        if(answer){this.drafts[doc.id]={...answer,action:answer.action==='回答'?'':answer.action,hash:doc.hash,questionText:doc.text,basis:this.basis(doc)};this.basisCache.clear();}
        this.render();
      });return;}
      this.navigate(()=>{
        if(b.hasAttribute('data-next')||b.hasAttribute('data-previous')){
          const visible=this.visible(),at=visible.findIndex(d=>d.id===this.session.question)+(b.hasAttribute('data-next')?1:-1);
          if(at>=visible.length||at<0){this.session.summary=true;this.session.summaryMode='round';}else this.selectQuestion(visible[at].id);
          this.render();
        }else if(b.hasAttribute('data-summary')){this.session.summary=true;this.session.summaryMode='round';this.render();}
        else if(b.hasAttribute('data-all-drafts')){this.session.summary=true;this.session.summaryMode='all';this.render();}
        else if(b.hasAttribute('data-all-questions')){this.session.directory=emptyDirectory();this.session.question='';this.session.summary=false;this.render();}
        else if(b.dataset.draftRound){
          this.session.round=b.dataset.draftRound;
          if(this.all().some(q=>questionRoundKey(q)===this.session.round&&q.status==='archived'&&filled(this.drafts[q.id]))){this.state().includeArchived=true;this.banner='本轮有归档回答，已显示归档问题供核对。';}
          this.session.question=this.round()[0]?.id??'';this.state().questionId=this.session.question;this.session.summary=true;this.session.summaryMode='round';this.render();
        }
        else if(b.dataset.question){this.selectQuestion(b.dataset.question);this.render();}
        else if(b.hasAttribute('data-handoff'))run(()=>this.handoff(b.hasAttribute('data-copy-opening')));
      });
    };
  }
  private feedback(){const feedback=this.host.querySelector<HTMLElement>('[role=status]');if(feedback)feedback.textContent=this.banner;}
  private async start(){
    if(isTransientProject(this.snapshot.project.id)){this.banner='示例问答只在本次会话保留；交给外部模型前请另存为正式项目。';if(await this.options.saveAs())return;this.render();return;}
    await openCollaboration('inquiry',this.snapshot,this.documentId?[this.documentId]:[],{fixed:true,title:this.documentId?'围绕当前文档发起一轮策问':'围绕当前项目发起一轮策问'});
  }
  private async handoff(copy=false){
    if(isTransientProject(this.snapshot.project.id)){this.banner='示例回答只在会话中保留；请先另存为项目，再从新项目打开本轮汇总。';this.render();await this.options.saveAs();return;}
    await this.saveRoundAnswers();
    const receipt=this.receipt();if(!receipt)throw new Error('本轮没有可分析的回答，请先回答问题。');
    if(copy){const copied=await copyAnswerOpening(this.snapshot,receipt);if(copied){this.banner='已复制开场白，请发送给你使用的 LLM；等待模型读取并分析。';this.render();return;}}
    await openCollaboration('answers',this.snapshot,[...new Set([...receipt.documentIds,...receipt.questions.map(q=>q.id)])],{fixed:true,title:'分析本轮回答，再确认是否继续',answers:receipt});
  }
  private async saveRoundAnswers(){
    if(this.snapshot.historical)throw new Error('历史版本只读，不能保存回答。');
    const round=this.round(),roundKey=this.session.round;
    const docs=this.projected(),answered=round.filter(d=>filled(this.drafts[d.id]));
    if(!answered.length){this.refreshReceipt(roundKey);return;}
    for(const doc of answered){
      if(this.reviewReason(doc))throw new Error(`“${doc.title}”需要先复核；旧草稿已经保留。`);
      if(!questionAvailable(doc,docs).active)throw new Error(`“${doc.title}”的前题条件尚未满足，请先复核。`);
    }
    const answers=answered.map(doc=>{const d=this.drafts[doc.id];return {documentId:doc.id,baseHash:doc.hash,choices:d.choices,text:d.text,action:d.action||'回答',supersedes:[...inquiry(doc).previous.matchAll(/### 回答 ([A-Za-z0-9_-]+)/g)].at(-1)?.[1]};});
    const signature=JSON.stringify(answers);if(signature!==this.signature){this.signature=signature;this.requestId=crypto.randomUUID();}
    this.busy=true;this.render();
    try{
      const next=await projectAction<ProjectSnapshot>(this.snapshot.project.id,'answers',{requestId:this.requestId,answers});
      for(const answer of answers)delete this.drafts[answer.documentId];
      this.snapshot=next;this.basisCache.clear();this.sourceWarnings.clear();this.session.receipts??={};
      // 本轮收据包含此前保存和本次修改的全部回答；空白题保持暂缓，不代选方案。
      this.refreshReceipt(roundKey);
      this.session.submittedBases??={};this.session.reviewedBases??={};
      for(const doc of answered){const saved=this.all().find(q=>q.id===doc.id);if(saved){const basis=this.basis(saved);this.session.submittedBases[doc.id]=basis;this.session.reviewedBases[doc.id]=basis;}}
      this.session.summary=true;this.session.summaryMode='round';
      this.banner=isTransientProject(next.project.id)?'示例回答已保留在本次会话，未创建本地项目文件。':'原始回答已保存。请复制开场白交给 LLM 分析整理。';
      this.save();this.options.apply(next);
      window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence',{detail:{name:'questions-answered',projectId:next.project.id}}));
    }finally{this.busy=false;this.render();}
  }
  /** 交接依据来自项目中的最新原始回答，重复制不会再次追加相同答案。 */
  private refreshReceipt(roundKey:string){
    const round=this.all().filter(q=>questionRoundKey(q)===roundKey&&(this.state().includeArchived||q.status!=='archived')),answered=round.filter(q=>latestAnswer(q));
    const validSources=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    const sourceIds=[...new Set(answered.flatMap(q=>questionSources(this.snapshot,q)).filter(id=>validSources.has(id)))];
    if(answered.length){this.session.receipts??={};this.session.receipts[roundKey]={...answerHandoff(this.snapshot,answered.map(q=>q.id),this.requestId||crypto.randomUUID(),sourceIds),roundQuestionIds:round.map(q=>q.id)};this.save();}
  }
  /** 新快照只更新目录、数量和提示；正在输入时保留表单及中文组合焦点。 */
  receive(next:ProjectSnapshot){
    if(this.disposed||next.project.id!==this.snapshot.project.id)return;
    const ids=new Set(this.all().map(q=>q.id));this.capture(false);this.snapshot=next;this.basisCache.clear();this.sourceWarnings.clear();this.rememberSubmittedBases();
    const added=this.all().filter(q=>!ids.has(q.id)).length;
    if(added)this.banner=`收到 ${added} 个新问题，可从项目问题目录选择；当前草稿已保留。`;
    const current=this.current();
    if(current){
      if(!this.session.summary)this.session.round=questionRoundKey(current);
      if(this.reviewReason(current))this.banner='当前题目、来源或前题已变化，草稿保留；修改回答即可使用当前题目。';
      else {const available=questionAvailable(current,this.projected());if(!available.active)this.banner=available.reason+'；本题仍可查看，草稿保留。';}
    }
    if(!current&&this.displayed)this.banner='当前题目已移除，原草稿保留在全部草稿中待复核。';
    if(this.composing||this.host.contains(document.activeElement)){this.feedback();this.renderNav();}
    else this.render();
  }
  show(nav:HTMLElement){
    if(nav!==this.nav){this.directory.dispose();this.nav=nav;this.directory=this.createDirectory();}
    this.renderNav();
  }
  dispose(){
    this.captureDraft();this.disposed=true;this.pendingNavigation=undefined;this.directory.dispose();
    this.host.removeEventListener('compositionstart',this.compositionStart);this.host.removeEventListener('compositionend',this.compositionEnd);
    this.host.oninput=null;this.host.onchange=null;this.host.onclick=null;this.host.onsubmit=null;
  }
}

