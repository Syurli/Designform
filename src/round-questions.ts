import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { inquiry, questionAvailable, answerQuestion, questionDisplayTitle, questionDisplayBackground, questionDefinition } from '../shared/inquiry';
import { readHeader } from '../shared/markdown';
import { isTransientProject } from '../shared/transient';
import { answerHandoff, questionRoundKey, type AnswerHandoff } from '../shared/answer-handoff';
import { resolveAnchor, hasAnchorTarget } from '../shared/creative/anchors';
import { relatedQuestions } from './creative/questions';
import { projectAction, readProject, ClientError } from './project-client';
import { copyAnswerOpening, openCollaboration } from './prompt-panel';
import { ProjectQuestionDirectory } from './project-question-directory';
import { questionDocuments, questionSources, questionFilter, questionMatchesFilter, questionStatusLabels, visibleProjectQuestions, type QuestionDirectoryState, type QuestionStateInfo } from './project-question-model';
import { h } from './creative/render';
import './round-questions.css';

interface Draft { hash:string; text:string; choices:string[]; action:string; questionText?:string; basis?:string }
/** 前题跳转仅改变个人浏览范围，返回时恢复搜索、筛选、轮次及汇总位置。 */
interface QuestionOrigin { questionId:string; directory:QuestionDirectoryState; summary:boolean; summaryMode?:'round'|'all'; round:string }
interface Session {
  round:string; question:string; summary:boolean; summaryMode?:'round'|'all';
  directory?:QuestionDirectoryState; receipt?:AnswerHandoff; receipts?:Record<string,AnswerHandoff>;
  /** 非法外部改题或移除时，旧输入仍在个人历史中保留，不混入新题答案。 */
  previousDrafts?:{id:string;title:string;draft:Draft}[];
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
  private autosaveTimer?:ReturnType<typeof setTimeout>;
  private syncing?:Promise<void>;
  private writing=new Set<string>();
  /** 请求结果未知时保留反向改答，不能用旧快照误判为“没有变化”。 */
  private unconfirmed=new Set<string>();
  private syncError='';
  private sourceWarnings=new Map<string,string>();
  private questionTrail:QuestionOrigin[]=[];
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
      filter:questionFilter(saved?.filter)};
    this.rebaseDrafts();this.directory=this.createDirectory();
    this.chooseInitial();
    if(options.initialQuestionId&&this.all().some(q=>q.id===options.initialQuestionId))this.selectQuestion(options.initialQuestionId);
    else if(options.initialDocumentId)this.setScope('',options.initialDocumentId);
    this.bind();this.render();this.scheduleRecording();
  }
  private state(){return this.session.directory!;}
  /** 同一题的多来源只影响定位，不能重复草稿、计数或提交。 */
  private all(){return [...new Map(this.snapshot.documents.filter(d=>d.type==='question').map(d=>[d.id,d])).values()];}
  private round(){return this.all().filter(d=>questionRoundKey(d)===this.session.round&&(this.state().includeArchived||d.status!=='archived'));}
  private current(){return this.all().find(d=>d.id===this.session.question);}
  private visible(records=this.records()){
    const questions=visibleProjectQuestions(this.snapshot,this.state(),records);
    return this.documentId&&!this.questionTrail.length?questions.filter(q=>relatedQuestions(this.snapshot,this.documentId).some(d=>d.id===q.id)):questions;
  }
  /** 每轮独立保留交接收据，不能借用另一轮实际提交的开场白。 */
  private receipt(){
    const r=this.session.receipts?.[this.session.round]??this.session.receipt;
    return r?.projectId===this.snapshot.project.id&&Array.isArray(r.questions)&&r.questions.length&&r.questions.every(q=>JSON.stringify([q.questId??'',q.roundId??q.round])===this.session.round)?r:undefined;
  }
  private preferred(questions:ProjectDocument[]){
    const docs=this.projected(),records=this.records(docs);
    return questions.find(q=>!latestAnswer(q)&&!filled(this.drafts[q.id])&&questionAvailable(q,docs).active)
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
      if((changedRound||changedSources)&&filled(this.drafts[previous.id]))this.banner='';
    }
    this.session.question=id;this.session.round=questionRoundKey(q);this.session.summary=false;
    this.state().questionId=id;
  }
  private setScope(group:string,documentId:string){
    this.state().group=group;this.state().documentId=documentId;
    const first=this.preferred(this.visible());
    if(first)this.selectQuestion(first.id);else{this.session.question='';this.state().questionId='';this.session.summary=false;}
  }
  /** 条件入口允许跨分类、文档和筛选打开真实前题，跳转前统一由 navigate 暂存表单。 */
  private openPrerequisite(id:string){
    const target=this.all().find(q=>q.id===id);
    if(!target){this.banner='前题已移除，请调整题目的关联。';this.render();return;}
    if(target.id===this.session.question||this.questionTrail.some(origin=>origin.questionId===id)){
      this.banner='题目存在循环前题关联，请调整关联。';this.feedback();return;
    }
    this.questionTrail.push({questionId:this.session.question,directory:{...this.state()},summary:this.session.summary,summaryMode:this.session.summaryMode,round:this.session.round});
    this.session.directory={...emptyDirectory(),group:'question-all',includeArchived:target.status==='archived'};
    this.selectQuestion(id);this.banner='';this.render();
  }
  /** 返回恢复原范围，不隐式保存其他轮回答；同轮草稿继续用于判断前题条件。 */
  private returnToQuestion(){
    const origin=this.questionTrail.pop();if(!origin)return;
    this.session.directory={...origin.directory};this.session.round=origin.round;
    this.session.question=origin.questionId;this.session.summary=origin.summary;this.session.summaryMode=origin.summaryMode;
    this.banner=this.current()?'':'原题已移除，已返回原来的浏览范围。';this.render();
  }
  /** 主作答区及汇总共用条件按钮，键盘也能直接打开前题；不存在的前题只显示说明。 */
  private condition(available:ReturnType<typeof questionAvailable>){
    if(available.active)return '';
    return `<p class="round-condition">${available.previousId?`<button type="button" class="round-condition-link" data-prerequisite="${h(available.previousId)}" aria-label="打开前题：${h(available.previousTitle)}">${h(available.reason)} ↗</button>`:h(available.reason)}</p>`;
  }
  private save(){
    if(isTransientProject(this.snapshot.project.id))return;
    try{
      localStorage.setItem('cewen-answers-090:'+this.snapshot.project.id,JSON.stringify(this.drafts));
      localStorage.setItem('cewen-round-sessions:'+this.snapshot.project.id,JSON.stringify(memory.get(this.snapshot.project.id)?.sessions??{}));
    }catch{this.banner='本机应急缓存不可用，当前输入仍保留并继续自动记录。';}
  }
  /** 外部改动只比较题意，文件 hash 与来源变化不再要求逐题复核。 */
  private rebaseDrafts(){
    for(const [id,draft] of Object.entries(this.drafts)){
      const doc=this.all().find(q=>q.id===id);if(!doc)continue;
      if(draft.questionText){
        const old={...doc,text:draft.questionText,title:readHeader(draft.questionText).body.match(/^# (.+)$/m)?.[1]??doc.title};
        if(questionDefinition(old)!==questionDefinition(doc)){
          this.session.previousDrafts??=[];this.session.previousDrafts.push({id,title:old.title,draft});delete this.drafts[id];continue;
        }
      }
      draft.hash=doc.hash;draft.questionText=doc.text;
      const saved=latestAnswer(doc);
      if(saved&&!this.writing.has(id)&&!this.unconfirmed.has(id)&&this.answerValue(draft)===this.answerValue(saved))delete this.drafts[id];
    }
  }
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
  /** 所有正在自动记录的回答用于前题预显，跨轮返回也无需额外保存。 */
  private projected(){
    const pending=this.all().filter(d=>filled(this.drafts[d.id]));
    if(!pending.length)return this.snapshot.documents;
    const docs=this.snapshot.documents.map(d=>({...d})),done=new Set<string>();
    for(let pass=0;pass<pending.length;pass++){
      let changed=false;
      for(const doc of pending){
        if(done.has(doc.id)||!questionAvailable(doc,docs).active)continue;
        const draft=this.drafts[doc.id];
        docs.find(d=>d.id===doc.id)!.text=answerQuestion(doc,{id:'draft-preview',choices:draft.choices,text:draft.text,action:draft.action||'回答',revision:this.snapshot.revision});
        done.add(doc.id);changed=true;
      }
      if(!changed)break;
    }
    return docs;
  }
  private records(docs=this.projected()):Record<string,QuestionStateInfo>{
    return Object.fromEntries(this.all().map(doc=>{
      const available=questionAvailable(doc,docs),draft=this.drafts[doc.id],answer=draft??latestAnswer(doc);
      const status:QuestionStateInfo['status']=answer?answer.action==='暂缓'?'deferred':answer.action==='前提不成立'?'premise':filled(draft)?'draft':'submitted':'pending';
      // 前题变化不抹去已经回答的历史，也不把已答题重新计入待答。
      return [doc.id,{id:doc.id,status,sourceIds:questionSources(this.snapshot,doc),blocked:!available.active&&!answer,reason:!available.active&&!answer?available.reason:''}];
    }));
  }
  private status(doc:ProjectDocument,record=this.records()[doc.id]){
    return `${questionStatusLabels[record.status]}${record.blocked?' · 待前题':''}`;
  }
  /** 离开作答区也会自动记录；应急缓存保留未完成写入，不增加人工步骤。 */
  captureDraft(){this.capture(false);this.save();this.notifyStats();this.scheduleRecording(0);}
  private capture(updateNav=true,acceptCurrent=false){
    const form=this.host.querySelector<HTMLFormElement>('[data-round-form]'),doc=this.displayed;
    if(!form||!doc||this.busy||this.snapshot.historical||form.querySelector('fieldset[disabled]'))return;
    const data=new FormData(form),choices=data.getAll('choice').map(String),text=String(data.get('text')??'');
    let action=String(data.get('action')??'');
    if(acceptCurrent&&action==='暂缓'&&(choices.length||text.trim())){
      action='';const field=form.querySelector<HTMLInputElement>('[name=action]');if(field)field.value='';
    }
    if(!choices.length&&!text.trim()&&!action&&(latestAnswer(doc)||this.writing.has(doc.id)||this.unconfirmed.has(doc.id)))action='暂缓';
    const draft:Draft={hash:doc.hash,choices,text,action,questionText:doc.text},saved=latestAnswer(this.current()??doc);
    if(filled(draft)&&(!saved||this.answerValue(draft)!==this.answerValue(saved)||this.writing.has(doc.id)||this.unconfirmed.has(doc.id)))this.drafts[doc.id]=draft;
    else delete this.drafts[doc.id];
    this.save();this.updateProgress();if(updateNav)this.renderNav();
    if(!this.composing)this.scheduleRecording();
  }
  /** 比较作答值而非文档 hash，重复失焦、切页和复制都不会追加相同答案。 */
  private answerValue(answer:{choices:string[];text:string;action:string}){return JSON.stringify([answer.choices,answer.text,answer.action||'回答']);}
  private scheduleRecording(delay=900){
    if(this.autosaveTimer)clearTimeout(this.autosaveTimer);
    if(this.snapshot.historical||isTransientProject(this.snapshot.project.id)||this.composing||!Object.values(this.drafts).some(filled))return;
    this.autosaveTimer=setTimeout(()=>{this.autosaveTimer=undefined;void this.flushAnswers().catch(error=>{
      this.syncError=error instanceof Error?error.message:String(error);this.banner='自动记录尚未完成，输入已保留。'+this.syncError;this.feedback();
      if(!this.disposed)this.scheduleRecording(5000);
    });},delay);
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
    this.capture(false);action();this.scheduleRecording(0);
  }
  private createDirectory(){
    return new ProjectQuestionDirectory(this.nav,{
      onScope:(group,documentId)=>this.navigate(()=>{this.setScope(group,documentId);this.render();}),
      onQuestion:id=>this.navigate(()=>{this.selectQuestion(id);this.render();}),
      onFilter:filter=>this.navigate(()=>{this.state().filter=filter;this.reselectScope();}),
      onQuery:query=>this.navigate(()=>{this.state().query=query;this.reselectScope();}),
      onArchived:show=>this.navigate(()=>{this.state().includeArchived=show;this.reselectScope();}),
      onSummary:()=>this.navigate(()=>{this.session.summary=true;this.session.summaryMode='all';this.render();}),
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
    this.options.onStateChange?.({pending:this.all().filter(q=>q.status!=='archived'&&questionMatchesFilter(records[q.id],'pending')).length,drafts:Object.values(this.drafts).filter(filled).length});
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
      this.host.innerHTML=`<div class="round-empty"><h2>${hasQuestions?'当前范围没有问题':'这个项目还没有问题'}</h2><p>${hasQuestions?'切换全部问题、状态筛选或清除搜索即可继续；回答已记录。':'可预览并编辑项目提问开场白，让 LLM 围绕本项目提出一轮明确问题；已有问题可从项目导入入口加入。'}</p><p class="round-feedback" role="status">${h(this.banner)}</p>${hasQuestions?'<button data-all-questions>查看全部问题</button>':''}<button data-start>生成项目提问开场白</button>${this.options.importQuestions?'<button data-import-questions>导入已有问题</button>':''}<button data-all-drafts>轮次汇总</button><button data-back>返回策划案</button></div>`;
      this.renderNav();return;
    }
    const count=round.filter(d=>{const a=this.drafts[d.id]??latestAnswer(d);return a&&a.action!=='暂缓'&&a.action!=='前提不成立'&&(a.choices.length||a.text.trim());}).length;
    this.host.innerHTML=`<header class="round-heading"><button data-back>← 返回策划案</button><div><strong>策问</strong>${this.session.summary&&this.session.summaryMode==='all'?'':`<small data-answer-progress>已回答 ${count} / ${round.length} 题</small>`}</div><button data-all-drafts>轮次汇总</button></header><p class="round-feedback" role="status">${h(this.banner)}</p><div class="round-content"></div>`;
    const content=this.host.querySelector<HTMLElement>('.round-content')!;
    if(this.session.summary){if(this.session.summaryMode==='all')this.roundCatalog(content);else this.summary(content);}else if(doc)this.question(content,doc);
    this.renderNav();
  }
  /** 作答区只放问题、必要背景与回答，协作来源和历史集中在折叠区。 */
  private question(content:HTMLElement,doc:ProjectDocument){
    const q=inquiry(doc),draft=this.drafts[doc.id],saved=latestAnswer(doc),answer=draft??saved;
    const available=questionAvailable(doc,this.projected()),visible=this.visible(),index=visible.findIndex(d=>d.id===doc.id);
    this.displayed=doc;
    const ids=questionSources(this.snapshot,doc),validSources=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    const background=questionDisplayBackground(q.background),issue=answer?.action==='前提不成立';
    content.innerHTML=`<article class="round-question">
      <small>${index>=0?`第 ${index+1} / ${visible.length} 题`:''}</small>
      ${this.returnLink()}
      <h2>${h(questionDisplayTitle(q.title))}</h2>
      ${background?`<p class="round-background">${h(background)}</p>`:''}
      ${this.condition(available)}
      <form data-round-form><fieldset ${this.snapshot.historical||!available.active?'disabled':''}>
        ${q.options.map(option=>`<label class="round-option"><input type="${q.multiple?'checkbox':'radio'}" name="choice" value="${h(option)}" ${answer?.choices.includes(option)?'checked':''}/><span>${h(option)}</span></label>`).join('')}
        <button type="button" class="round-text-button" data-clear-choice>清除选择</button>
        <label>我的回答 / 补充理由<textarea name="text" rows="4" placeholder="直接写下你的想法；不填写的题目可以稍后再答。">${h(answer?.text??'')}</textarea></label>
        <input type="hidden" name="action" value="${h(answer?.action==='回答'?'':answer?.action??'')}"/>
        <div class="round-answer-actions"><button type="button" data-question-issue aria-pressed="${issue}">${issue?'已标记题目有问题 · 取消':'题目有问题'}</button>${issue?'<span>可在回答中说明需要调整的地方。</span>':''}</div>
      </fieldset></form>
      <details class="round-source"><summary>查看依据与此前回答</summary>
        ${ids.map(id=>{const source=this.snapshot.documents.find(d=>d.id===id);return source&&validSources.has(id)?`<button data-source="${h(id)}">${h(source.title)}</button><pre>${h(readHeader(source.text).body.slice(0,5000))}</pre>`:`<p>关联记录暂不可定位：${h(id)}</p>`;}).join('')}
        ${this.sourceWarning(doc)?`<p>${h(this.sourceWarning(doc))}</p>`:''}
        <h4>此前回答</h4><pre>${h(q.previous)}</pre>
        ${!['','尚未形成。'].includes(q.interpretation)?`<h4>分析</h4><pre>${h(q.interpretation)}</pre>`:''}
        ${!['','尚未采纳。'].includes(q.decision)?`<h4>决定记录</h4><pre>${h(q.decision)}</pre>`:''}
      </details>
      <footer class="round-navigation"><button data-previous ${index<=0?'disabled':''}>上一题</button><span>回答自动记录</span><button class="primary-button" data-next>${index>=visible.length-1?'查看本轮汇总':'下一题'}</button></footer>
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
    content.innerHTML=`<div class="round-summary-tools"><h2>${h(round[0]?inquiry(round[0]).round:'本轮回答汇总')}</h2></div>
      ${this.returnLink()}
      <p class="round-result-count">已回答 ${answered} 题 · 暂缓 ${round.length-answered-issues} 题${issues?` · 题目有问题 ${issues} 题`:''}</p>
      <div class="round-summary">${[...groups].map(([source,questions])=>`<section class="round-summary-group"><h3>${h(source?this.snapshot.documents.find(d=>d.id===source)?.title??'其他问题':'其他问题')}</h3>${questions.map(doc=>{
        const answer=result(doc),available=questionAvailable(doc,docs);
        return `<article><header><strong>${++index}. ${h(questionDisplayTitle(doc.title))}</strong><button data-question="${h(doc.id)}">修改回答</button></header>
          ${answer?.action==='前提不成立'?'<small>题目有问题</small>':''}
          ${answer?.choices.length?`<p>${h(answer.choices.join('；'))}</p>`:''}
          ${answer?.text?`<p class="round-verbatim">${h(answer.text)}</p>`:''}
          ${!answer||answer.action==='暂缓'?'<p class="quiet">暂缓，稍后再答</p>':''}
          ${this.condition(available)}
        </article>`;
      }).join('')}</section>`).join('')}</div>
      <section class="round-handoff"><h3>交给 LLM 分析</h3>
        <p>回答已自动记录。复制开场白发给 LLM，讨论后再开始下一轮。</p>
        <button data-handoff data-copy-opening class="primary-button" ${this.busy||this.snapshot.historical||!canHandoff?'disabled':''}>${this.busy?'正在准备开场白…':'复制开场白，请 LLM 分析'}</button>
        <button data-handoff ${this.busy||this.snapshot.historical||!canHandoff?'disabled':''}>预览 / 编辑开场白</button>
        ${this.options.hasUnsaved()?'<small>策划正文还有未保存修改，分析将使用已保存正文。</small>':''}
      </section>`;
  }
  /** 前题返回只恢复浏览位置，回答由统一自动记录队列处理。 */
  private returnLink(){
    const origin=this.questionTrail.at(-1);if(!origin)return '';
    const target=this.all().find(q=>q.id===origin.questionId);
    return `<div class="round-return"><button type="button" data-return-question title="${h(target?questionDisplayTitle(target.title):'原来的浏览位置')}">${origin.summary?'返回原汇总':'返回原题'} ↩</button></div>`;
  }
  /** 汇总入口列出全项目所有轮次，每轮一张卡片，不展开整项目的问题清单。 */
  private roundCatalog(content:HTMLElement){
    const groups=new Map<string,ProjectDocument[]>();
    for(const q of this.all()){const key=questionRoundKey(q);groups.set(key,[...(groups.get(key)??[]),q]);}
    const rounds=[...groups].reverse(),missing=Object.keys(this.drafts).filter(id=>filled(this.drafts[id])&&!this.all().some(q=>q.id===id));
    content.innerHTML=`<div class="round-summary-tools"><h2>轮次汇总</h2><button data-summary>查看当前轮</button></div>
      <p class="quiet">每轮独立查看回答、复制开场白；旧轮问答始终保留。</p>
      <div class="round-catalog">${rounds.map(([key,questions])=>{
        const answers=questions.map(q=>this.drafts[q.id]??latestAnswer(q)),answered=answers.filter(a=>a&&a.action!=='暂缓'&&a.action!=='前提不成立'&&(a.choices.length||a.text.trim())).length,issues=answers.filter(a=>a?.action==='前提不成立').length;
        return `<section class="round-card"><header><h3>${h(inquiry(questions[0]).round)}</h3><button data-draft-round="${h(key)}">查看本轮</button></header><p>共 ${questions.length} 题 · 已回答 ${answered} 题 · 暂缓 ${questions.length-answered-issues} 题${issues?` · 题目有问题 ${issues} 题`:''}</p>${key===this.session.round?'<small>当前轮次</small>':''}</section>`;
      }).join('')||'<p>还没有轮次。</p>'}</div>
      ${missing.length||this.session.previousDrafts?.length?`<details class="round-source"><summary>查看旧题的未完成记录</summary>${missing.map(id=>`<details><summary>${h(id)} · 题目已移除</summary><p>${h(this.drafts[id].choices.join('；'))}</p><p class="round-verbatim">${h(this.drafts[id].text)}</p></details>`).join('')}${(this.session.previousDrafts??[]).map(old=>`<details><summary>${h(old.title)} · 题意已变化</summary><p>${h(old.draft.choices.join('；'))}</p><p class="round-verbatim">${h(old.draft.text)}</p></details>`).join('')}</details>`:''}`;
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
      if(b.dataset.prerequisite){this.navigate(()=>this.openPrerequisite(b.dataset.prerequisite!));return;}
      if(b.hasAttribute('data-return-question')){this.navigate(()=>this.returnToQuestion());return;}
      if(b.hasAttribute('data-start')){this.capture();run(()=>this.start());return;}
      if(b.hasAttribute('data-import-questions')){this.navigate(()=>this.options.importQuestions?.());return;}
      if(b.hasAttribute('data-clear-choice')){this.host.querySelectorAll<HTMLInputElement>('[name=choice]').forEach(input=>input.checked=false);this.capture(true,true);return;}
      if(b.hasAttribute('data-question-issue')){
        const action=this.host.querySelector<HTMLInputElement>('[name=action]');if(!action)return;
        action.value=action.value==='前提不成立'?'':'前提不成立';this.capture(true,true);this.render();return;
      }
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
          if(this.all().some(q=>questionRoundKey(q)===this.session.round&&q.status==='archived')){this.state().includeArchived=true;this.banner='本轮包含归档问题。';}
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
    if(isTransientProject(this.snapshot.project.id)){this.banner='示例回答只在会话中保留；请先另存为项目。';this.render();await this.options.saveAs();return;}
    this.busy=true;this.feedback();
    try{
      // 复制只等待尚在进行的自动记录，不是一次人工提交，也不重写旧答案。
      await this.flushAnswers();
      if(this.round().some(doc=>filled(this.drafts[doc.id])))throw new Error(this.syncError||'本轮有回答尚未记录，请检查前题条件或服务连接；输入仍保留。');
      this.refreshReceipt(this.session.round);
      const receipt=this.receipt();if(!receipt)throw new Error('本轮没有可分析的回答，请先回答问题。');
      if(copy&&await copyAnswerOpening(this.snapshot,receipt)){this.banner='已复制开场白，请发给 LLM 讨论。';return;}
      await openCollaboration('answers',this.snapshot,[...new Set([...receipt.documentIds,...receipt.questions.map(q=>q.id)])],{fixed:true,title:'分析本轮回答，再确认是否继续',answers:receipt});
    }finally{this.busy=false;this.render();this.scheduleRecording();}
  }
  /** 连续输入合并记录，写入期间不禁用表单；后续输入不会被已完成的旧请求清除。 */
  private async flushAnswers():Promise<void>{
    if(this.syncing){await this.syncing;return this.flushAnswers();}
    if(this.snapshot.historical||isTransientProject(this.snapshot.project.id)||this.composing)return;
    if(this.autosaveTimer){clearTimeout(this.autosaveTimer);this.autosaveTimer=undefined;}
    this.syncing=this.recordPending();
    try{await this.syncing;}finally{this.syncing=undefined;}
  }
  private async recordPending(){
    for(;;){
      this.rebaseDrafts();const docs=this.projected();
      const pending=this.all().filter(doc=>filled(this.drafts[doc.id])&&questionAvailable(doc,docs).active);
      if(!pending.length)return;
      // 不同轮可自动记录，但模型交接仍只读取用户选择的这一轮。
      const sent=new Map(pending.map(doc=>[doc.id,this.answerValue(this.drafts[doc.id])]));
      const answers=pending.map(doc=>{const d=this.drafts[doc.id];return {documentId:doc.id,baseHash:doc.hash,choices:[...d.choices],text:d.text,action:d.action||'回答'};});
      const signature=JSON.stringify(answers);if(signature!==this.signature){this.signature=signature;this.requestId=crypto.randomUUID();}
      this.writing=new Set(pending.map(doc=>doc.id));
      for(const doc of pending)this.unconfirmed.add(doc.id);
      let next:ProjectSnapshot;
      try{next=await projectAction<ProjectSnapshot>(this.snapshot.project.id,'answers',{requestId:this.requestId,answers});}
      catch(error){
        if(error instanceof ClientError&&!['OFFLINE','SERVICE_UNAVAILABLE','REQUEST_FAILED','LOCAL_IO_ERROR','RECOVERY_REQUIRED'].includes(error.code))for(const doc of pending)this.unconfirmed.delete(doc.id);
        // 实际文件冲突先刷新，依据题意决定保留还是转存旧输入，绝不覆盖外部新题。
        if(error instanceof ClientError&&['QUESTION_CHANGED','FILE_CONFLICT'].includes(error.code)){
          this.snapshot=await readProject(this.snapshot.project.id);this.rebaseDrafts();this.sourceWarnings.clear();this.save();
        }
        throw error;
      }finally{this.writing.clear();}
      for(const doc of pending)this.unconfirmed.delete(doc.id);
      for(const [id,value] of sent)if(this.drafts[id]&&this.answerValue(this.drafts[id])===value)delete this.drafts[id];
      this.snapshot=next;this.rebaseDrafts();this.sourceWarnings.clear();this.syncError='';
      if(this.banner.startsWith('自动记录尚未完成'))this.banner='';
      this.save();
      if(!this.disposed){
        // 让 capture 继续使用新的正文基准，原表单和输入法焦点不替换。
        if(this.displayed)this.displayed=this.current();
        this.options.apply(next);this.renderNav();this.updateProgress();this.feedback();
        window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence',{detail:{name:'questions-answered',projectId:next.project.id}}));
      }
      if(this.composing)return;
    }
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
    const ids=new Set(this.all().map(q=>q.id));this.capture(false);this.snapshot=next;this.sourceWarnings.clear();this.rebaseDrafts();
    const added=this.all().filter(q=>!ids.has(q.id)).length;
    if(added)this.banner=`收到 ${added} 个新问题，可从项目问题目录选择；当前回答已保留。`;
    const current=this.current();
    if(current){
      if(!this.session.summary)this.session.round=questionRoundKey(current);
      const available=questionAvailable(current,this.projected());if(!this.session.summary&&!available.active&&!latestAnswer(current))this.banner=available.reason;
    }
    if(!current&&this.displayed)this.banner='当前题目已移除，原输入保留在轮次汇总的旧题记录中。';
    const changed=!!current&&!!this.displayed&&questionDefinition(current)!==questionDefinition(this.displayed);
    if(changed&&this.composing)this.pendingNavigation=()=>this.render();
    if(!changed&&(this.composing||this.host.contains(document.activeElement))){this.feedback();this.renderNav();}
    else if(changed&&this.composing){this.feedback();this.renderNav();}
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

