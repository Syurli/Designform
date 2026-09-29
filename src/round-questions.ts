import type { ProjectDocument, ProjectSnapshot } from '../shared/model';
import { inquiry, questionAvailable, answerQuestion } from '../shared/inquiry';
import { readHeader } from '../shared/markdown';
import { isTransientProject } from '../shared/transient';
import { answerHandoff, questionRoundKey, type AnswerHandoff } from '../shared/answer-handoff';
import { buildCreativeIndex } from '../shared/creative/content';
import { resolveAnchor } from '../shared/creative/anchors';
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
      if(changedRound||changedSources)this.banner=`已切换到${changedSources?'另一来源文档的':''}${inquiry(q).round}；上一题只暂存，未提交。`;
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
    }catch{this.banner='本机草稿缓存不可用，当前会话仍保留，请及时复制或提交。';}
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
    if(meta.anchor){
      const resolved=resolveAnchor(this.snapshot,meta.anchor);
      if(resolved.state==='missing'||resolved.state==='ambiguous')return remember(resolved.reason);
      const anchor=meta.anchor as {documentHash?:string};
      if(anchor.documentHash&&this.snapshot.documents.find(d=>d.id===resolved.documentId)?.hash!==anchor.documentHash)return remember('来源正文已变化，请核对当前来源。');
    }
    return remember('');
  }
  private sourceReason(doc:ProjectDocument){
    const warning=this.sourceWarning(doc);if(warning)return warning;
    const saved=this.session.submittedBases?.[doc.id];
    if(saved&&saved!==this.basis(doc))return '已提交回答的来源或前题已变化，请复核后改答。';
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
      const status:QuestionStateInfo['status']=review||latestAnswer(doc)&&!available.active?'review':filled(draft)?draft!.action==='暂缓'?'deferred':draft!.action==='前提不成立'?'premise':'draft':latestAnswer(doc)?'submitted':'pending';
      return [doc.id,{id:doc.id,status,sourceIds:questionSources(this.snapshot,doc),blocked:!available.active,reason:[review,!available.active?available.reason:''].filter(Boolean).join('；')}];
    }));
  }
  private status(doc:ProjectDocument,record=this.records()[doc.id]){
    const labels:Record<QuestionStateInfo['status'],string>={review:'待复核',draft:'已填写草稿',deferred:'暂缓草稿',premise:'前提不成立草稿',submitted:'已提交',pending:'待回答'};
    return `${labels[record.status]}${record.blocked?' · 条件尚未满足':''}`;
  }
  /** 公开收尾入口供模式退出使用，只保存草稿，不销毁会话或提交。 */
  captureDraft(){this.capture(false);this.save();this.notifyStats();}
  private capture(updateNav=true){
    const form=this.host.querySelector<HTMLFormElement>('[data-round-form]'),doc=this.displayed;
    if(!form||!doc||this.busy||this.snapshot.historical)return;
    // 禁用条件题的 FormData 不含输入，不能据此删掉此前的草稿。
    if(form.querySelector('fieldset[disabled]'))return;
    const data=new FormData(form),choices=data.getAll('choice').map(String),text=String(data.get('text')??''),action=String(data.get('action')??'');
    const old=this.drafts[doc.id];
    if(old&&old.hash!==doc.hash)for(const choice of old.choices)if(!inquiry(doc).options.includes(choice)&&!choices.includes(choice))choices.push(choice);
    if(choices.length||text.trim()||action)this.drafts[doc.id]={hash:old?.hash??doc.hash,choices,text,action,questionText:old?.questionText??doc.text,basis:old?.basis??this.basis(doc)};
    else delete this.drafts[doc.id];
    this.basisCache.clear();this.save();if(updateNav)this.renderNav();
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
    this.options.onStateChange?.({pending:this.all().filter(q=>q.status!=='archived'&&records[q.id]?.status!=='submitted').length,drafts:Object.values(this.drafts).filter(filled).length});
  }
  private sourceLabel(doc:ProjectDocument){
    return questionSources(this.snapshot,doc).map(id=>this.snapshot.documents.find(d=>d.id===id)?.title??`失效来源 ${id}`).join('、')||'未关联问题';
  }
  private render(){
    if(this.disposed)return;
    this.chooseInitial();this.save();const doc=this.current(),round=this.round();this.displayed=undefined;
    if(!doc&&!this.session.summary){
      const hasQuestions=this.all().length>0;
      this.host.innerHTML=`<div class="round-empty"><h2>${hasQuestions?'当前范围没有问题':'这个项目还没有问题'}</h2><p>${hasQuestions?'切换全部问题、状态筛选或清除搜索即可继续；回答草稿仍然保留。':'可预览并编辑项目提问开场白，让 LLM 围绕本项目提出一轮明确问题；已有问题可从项目导入入口加入。'}</p><p class="round-feedback" role="status">${h(this.banner)}</p>${hasQuestions?'<button data-all-questions>查看全部问题</button>':''}<button data-start>生成项目提问开场白</button>${this.options.importQuestions?'<button data-import-questions>导入已有问题</button>':''}<button data-all-drafts>全部草稿</button><button data-back>返回策划案</button></div>`;
      this.renderNav();return;
    }
    const count=round.filter(d=>filled(this.drafts[d.id])).length,submitted=round.filter(d=>latestAnswer(d)).length;
    this.host.innerHTML=`<header class="round-heading"><button data-back>← 返回策划案</button><div><strong>${h(doc?this.sourceLabel(doc):this.snapshot.project.name)}</strong><small>${h(doc?inquiry(doc).round:'项目草稿')} · 本轮草稿 ${count}／${round.length} · 已提交 ${submitted}／${round.length}</small></div><button data-summary>本轮汇总</button><button data-all-drafts>全部草稿</button></header><p class="round-feedback" role="status">${h(this.banner)}</p><div class="round-content"></div>`;
    const content=this.host.querySelector<HTMLElement>('.round-content')!;
    if(this.session.summary){if(this.session.summaryMode==='all')this.allDrafts(content);else this.summary(content);}else if(doc)this.question(content,doc);
    this.renderNav();
  }
  private question(content:HTMLElement,doc:ProjectDocument){
    const q=inquiry(doc),draft=this.drafts[doc.id],available=questionAvailable(doc,this.projected()),visible=this.visible(),index=visible.findIndex(d=>d.id===doc.id),review=this.reviewReason(doc);
    this.displayed=doc;
    const ids=questionSources(this.snapshot,doc),validSources=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    content.innerHTML=`<article class="round-question"><small>${index>=0?`当前范围第 ${index+1}／${visible.length} 题`:'当前题已不在筛选范围，草稿仍保留'} · ${this.status(doc)}</small><h2>${h(q.title)}</h2><p class="round-background">${h(q.background)}</p>${review?`<section class="round-warning"><strong>${h(review)}</strong>${draft?`<details><summary>查看草稿对应的旧题</summary><pre>${h(draft.questionText??'旧题正文未缓存，请对照历史版本。')}</pre></details><p>旧选择：${h(draft.choices.join('；')||'无')}。已移除的选项不会替你转换。</p>`:''}<button data-reviewed ${available.active&&!this.snapshot.historical?'':'disabled'}>我已核对当前题目与来源</button></section>`:''}${!available.active?`<p class="round-warning">${h(available.reason)}。本题仍可查看，旧回答与草稿保留。</p>`:''}${!draft&&latestAnswer(doc)?'<p>本题已有已提交回答。<button data-revise>在上次答案基础上修改</button></p>':''}<form data-round-form><fieldset ${this.snapshot.historical||!available.active?'disabled':''}>${q.options.map(option=>`<label class="round-option"><input type="${q.multiple?'checkbox':'radio'}" name="choice" value="${h(option)}" ${draft?.choices.includes(option)?'checked':''}/><span>${h(option)}</span></label>`).join('')}<button type="button" data-clear-choice>清除预设选择，改为自由回答</button><label>我的回答／补充理由<textarea name="text" rows="5" placeholder="可以直接表达你的想法、条件和理由。">${h(draft?.text??'')}</textarea></label><label>本题处理<select name="action"><option value="">回答（有内容时计入汇总）</option><option value="暂缓" ${draft?.action==='暂缓'?'selected':''}>暂缓</option><option value="前提不成立" ${draft?.action==='前提不成立'?'selected':''}>前提不成立</option></select></label></fieldset></form><details class="round-source"><summary>原文依据与此前回答</summary>${ids.map(id=>{const source=this.snapshot.documents.find(d=>d.id===id);return source&&validSources.has(id)?`<button data-source="${h(id)}">返回正文：${h(source.title)}</button><pre>${h(readHeader(source.text).body.slice(0,5000))}</pre>`:`<p class="round-warning">来源 ${h(id)} 已失效；本题保留待复核。</p>`;}).join('')}<h4>原始回答</h4><pre>${h(q.previous)}</pre><h4>模型解释</h4><pre>${h(q.interpretation)}</pre><h4>决定记录</h4><pre>${h(q.decision)}</pre></details><footer class="round-navigation"><button data-previous ${index<=0?'disabled':''}>上一题</button><span>沿当前范围切题，可跨文档与轮次；只暂存</span><button class="primary-button" data-next>${index>=visible.length-1?'核对本轮汇总':'下一题'}</button></footer></article>`;
  }
  private summary(content:HTMLElement){
    const round=this.round(),receipt=this.receipt(),groups=new Map<string,ProjectDocument[]>(),docs=this.projected(),records=this.records(docs);
    const valid=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    for(const doc of round){const ids=questionSources(this.snapshot,doc),source=ids.find(id=>valid.has(id))??ids[0]??'';groups.set(source,[...(groups.get(source)??[]),doc]);}
    let index=0;
    content.innerHTML=`<div class="round-summary-tools"><h2>本轮汇总 · ${h(round[0]?inquiry(round[0]).round:'尚未选择轮次')}</h2><button data-all-drafts>查看全部草稿</button></div><p>包含全项目同一轮次的问题，归档题按“含归档”开关显示；按来源文档归组，多来源题只列一次。只提交勾选的已填写回答，其他轮次草稿不参与。</p><div class="round-summary">${[...groups].map(([source,questions])=>`<section class="round-summary-group"><h3>${h(source?this.snapshot.documents.find(d=>d.id===source)?.title??`失效来源 ${source}`:'未关联问题')}</h3>${questions.map(doc=>{
      const draft=this.drafts[doc.id],answer=latestAnswer(doc),available=questionAvailable(doc,docs),review=this.reviewReason(doc);
      return `<article><header><strong>${++index}. ${h(doc.title)}</strong><button data-question="${h(doc.id)}">查看／修改</button></header><small>${this.status(doc,records[doc.id])} · ${h(this.sourceLabel(doc))}</small>${filled(draft)?`<label class="round-submit-choice"><input type="checkbox" data-submit-question="${h(doc.id)}" ${!review&&available.active?'checked':''} ${this.snapshot.historical?'disabled':''}/> 本次提交此题</label>`:''}${review||!available.active?`<p class="round-warning">${h(review||available.reason)}</p>`:''}<p>${h(draft?.choices.join('；')||answer?.choices.join('；')||'未选择预设选项')}</p><p class="round-verbatim">${h(draft?.text||(!draft?answer?.text:'')||'本次未填写自定义回答')}</p>${draft?.action?`<p>${h(draft.action)}</p>`:''}</article>`;
    }).join('')}</section>`).join('')}</div><button class="primary-button" data-submit ${this.busy||this.snapshot.historical||!round.some(d=>filled(this.drafts[d.id]))?'disabled':''}>${this.busy?'正在提交…':'提交本轮勾选回答'}</button>${receipt?`<section class="round-handoff"><h3>本轮回答已提交</h3><p>已保存 ${receipt.questions.length} 份回答。交给 LLM 分析后，由你决定是否开始下一轮。</p>${this.options.hasUnsaved()?'<p>正文还有未保存修改，MCP 将读取已保存版本。</p>':''}<button data-handoff data-copy-opening class="primary-button">复制给 LLM 的开场白</button><button data-handoff>预览／编辑开场白</button><button data-back>返回策划案</button></section>`:''}`;
    const card=content.querySelector('.round-handoff');if(card)content.prepend(card);
  }
  private allDrafts(content:HTMLElement){
    const groups=new Map<string,ProjectDocument[]>(),records=this.records();
    for(const q of this.all().filter(d=>filled(this.drafts[d.id]))){const key=questionRoundKey(q);groups.set(key,[...(groups.get(key)??[]),q]);}
    const missing=Object.keys(this.drafts).filter(id=>filled(this.drafts[id])&&!this.all().some(q=>q.id===id));
    content.innerHTML=`<div class="round-summary-tools"><h2>全部回答草稿</h2><button data-summary>返回本轮汇总</button></div><p>按轮次查看或跳转。这里不提供跨轮提交；打开一轮汇总后，再明确勾选该轮答案。</p>${[...groups].map(([key,questions])=>`<section class="round-draft-group"><header><h3>${h(inquiry(questions[0]).round)} · ${questions.length} 份草稿</h3><button data-draft-round="${h(key)}">打开该轮汇总</button></header>${questions.map(q=>`<button class="round-draft-question" data-question="${h(q.id)}"><strong>${h(q.title)}</strong><small>${h(this.sourceLabel(q))} · ${this.status(q,records[q.id])}</small></button>`).join('')}</section>`).join('')||'<p>没有未提交回答草稿。</p>'}${missing.length?`<section class="round-warning"><h3>题目已移除，草稿仍保留</h3>${missing.map(id=>`<details><summary>${h(id)} · 待复核</summary><pre>${h(this.drafts[id].questionText??'旧题正文未缓存')}</pre><p>${h(this.drafts[id].choices.join('；'))}</p><p class="round-verbatim">${h(this.drafts[id].text)}</p></details>`).join('')}</section>`:''}`;
  }
  private compositionStart=()=>{this.composing=true;};
  private compositionEnd=()=>{
    this.composing=false;this.capture();const action=this.pendingNavigation;this.pendingNavigation=undefined;
    if(action)queueMicrotask(()=>{if(!this.disposed)this.navigate(action);});
  };
  private bind(){
    this.host.addEventListener('compositionstart',this.compositionStart);this.host.addEventListener('compositionend',this.compositionEnd);
    this.host.oninput=()=>this.capture();
    // 点击目录会先让文本框失焦；此时不能在按下与抬起之间替换目标按钮。
    // 输入事件已更新目录状态，失焦仅补存最终值与数量，不重绘导航。
    this.host.onchange=()=>{this.capture(false);this.notifyStats();};
    this.host.onsubmit=e=>e.preventDefault();
    this.host.onclick=e=>{
      const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b||b.disabled||this.busy)return;
      const run=(fn:()=>Promise<unknown>)=>void fn().catch(err=>{this.banner=err instanceof Error?err.message:String(err);this.feedback();});
      if(b.hasAttribute('data-back')){this.navigate(()=>this.options.back());return;}
      if(b.dataset.source){this.navigate(()=>this.options.source(b.dataset.source!));return;}
      if(b.hasAttribute('data-start')){this.capture();run(()=>this.start());return;}
      if(b.hasAttribute('data-import-questions')){this.navigate(()=>this.options.importQuestions?.());return;}
      if(b.hasAttribute('data-clear-choice')){this.host.querySelectorAll<HTMLInputElement>('[name=choice]').forEach(input=>input.checked=false);this.capture();return;}
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
          if(this.all().some(q=>questionRoundKey(q)===this.session.round&&q.status==='archived'&&filled(this.drafts[q.id]))){this.state().includeArchived=true;this.banner='本轮有归档草稿，已显示归档问题供复核；尚未提交。';}
          this.session.question=this.round()[0]?.id??'';this.state().questionId=this.session.question;this.session.summary=true;this.session.summaryMode='round';this.render();
        }
        else if(b.dataset.question){this.selectQuestion(b.dataset.question);this.render();}
        else if(b.hasAttribute('data-submit'))run(()=>this.submit());
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
    const receipt=this.receipt();if(!receipt)return;
    if(copy){const copied=await copyAnswerOpening(this.snapshot,receipt);if(copied){this.banner='已复制开场白，请发送给你使用的 LLM；等待模型读取并分析。';this.render();return;}}
    await openCollaboration('answers',this.snapshot,[...new Set([...receipt.documentIds,...receipt.questions.map(q=>q.id)])],{fixed:true,title:'分析本轮回答，再确认是否继续',answers:receipt});
  }
  private async submit(){
    if(this.snapshot.historical)throw new Error('历史版本只读，不能提交回答。');
    const round=this.round(),roundKey=this.session.round;
    const selected=new Set([...this.host.querySelectorAll<HTMLInputElement>('[data-submit-question]:checked')].map(el=>el.dataset.submitQuestion!));
    const docs=this.projected(selected),answered=round.filter(d=>filled(this.drafts[d.id])&&selected.has(d.id));
    if(!answered.length)throw new Error('请勾选本次需要提交的已填写问题。');
    for(const doc of answered){
      if(this.reviewReason(doc))throw new Error(`“${doc.title}”需要先复核；旧草稿已经保留。`);
      if(!questionAvailable(doc,docs).active)throw new Error(`“${doc.title}”的前题条件尚未满足，请先复核。`);
    }
    const answers=answered.map(doc=>{const d=this.drafts[doc.id];return {documentId:doc.id,baseHash:doc.hash,choices:d.choices,text:d.text,action:d.action||'回答',supersedes:[...inquiry(doc).previous.matchAll(/### 回答 ([A-Za-z0-9_-]+)/g)].at(-1)?.[1]};});
    const validSources=new Set(questionDocuments(this.snapshot).map(d=>d.id));
    const sourceIds=[...new Set(answered.flatMap(q=>questionSources(this.snapshot,q)).filter(id=>validSources.has(id)))];
    const signature=JSON.stringify(answers);if(signature!==this.signature){this.signature=signature;this.requestId=crypto.randomUUID();}
    this.busy=true;this.render();
    try{
      const next=await projectAction<ProjectSnapshot>(this.snapshot.project.id,'answers',{requestId:this.requestId,answers});
      for(const answer of answers)delete this.drafts[answer.documentId];
      this.snapshot=next;this.basisCache.clear();this.sourceWarnings.clear();this.session.receipts??={};
      // 收据只绑定本次勾选题的去重来源；无源题仍由稳定问题身份交接。
      this.session.receipts[roundKey]=answerHandoff(next,answers.map(a=>a.documentId),this.requestId,sourceIds);
      this.session.submittedBases??={};this.session.reviewedBases??={};
      for(const doc of answered){const saved=this.all().find(q=>q.id===doc.id);if(saved){const basis=this.basis(saved);this.session.submittedBases[doc.id]=basis;this.session.reviewedBases[doc.id]=basis;}}
      this.session.summary=true;this.session.summaryMode='round';
      this.banner=isTransientProject(next.project.id)?'示例回答已保留在本次会话，未创建本地项目文件。':'原始回答已保存。请复制开场白交给 LLM 分析整理。';
      this.save();this.options.apply(next);
      window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence',{detail:{name:'questions-answered',projectId:next.project.id}}));
    }finally{this.busy=false;this.render();}
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
      if(this.reviewReason(current))this.banner='当前题目、来源或前题已变化，草稿保留；请核对后再提交。';
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

