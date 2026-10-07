import type { ProjectSnapshot, ProjectDocument } from './model.ts';
import { readHeader } from './markdown.ts';
import { inquiry } from './inquiry.ts';
import { answerContextRefs, latestSavedAnswer } from './answer-context.ts';
export { questionRoundKey } from './answer-context.ts';
import { questionRoundKey } from './answer-context.ts';

/** 开场白绑定成功保存的回答，私有草稿不进入外发上下文。 */
export interface AnswerHandoff {
  projectId:string; requestId:string; revision:string|null; revisionLabel?:string; documentIds:string[]; roundQuestionIds?:string[];
  questions:{id:string;answerId:string;hash:string;round:string;questId?:string;roundId?:string}[];
}
export function answerHandoff(snapshot:ProjectSnapshot,ids:string[],requestId:string,documentIds:string[]=[]):AnswerHandoff {
  return {projectId:snapshot.project.id,requestId,revision:snapshot.revision,revisionLabel:snapshot.revisionLabel,documentIds,questions:ids.map(id=>{
    const doc=snapshot.documents.find(d=>d.id===id)!;const q=inquiry(doc),m=readHeader(doc.text).metadata;
    return {id,answerId:[...q.previous.matchAll(/### 回答 ([A-Za-z0-9_-]+)/g)].at(-1)?.[1]??'',hash:doc.hash,round:q.round,...(typeof m.questId==='string'?{questId:m.questId}:{}),...(typeof m.roundId==='string'?{roundId:m.roundId}:{})};
  })};
}

/** 普通问询与 Quest 共用分析边界；不能把复制动作当作下一轮授权。 */
export const answerAnalysisRules='请分析原话，区分推断、建议与待澄清，保留条件和理由，不代答。正文按 D 号读取；修改先提案。改题或追问使用新题、新轮，保留旧问答；下一轮须等我明确同意。';

export function answerHandoffContext(receipt:AnswerHandoff,snapshot?:ProjectSnapshot):string {
  const roundKeys=new Set(receipt.questions.map(q=>JSON.stringify([q.questId??'',q.roundId??q.round])));
  // 用汇总的实际范围计数；旧收据默认不包含未明确选择查看的归档题。
  const other=snapshot?.documents.filter(d=>d.type==='question'&&(receipt.roundQuestionIds?receipt.roundQuestionIds.includes(d.id):d.status!=='archived')&&roundKeys.has(questionRoundKey(d))&&!receipt.questions.some(q=>q.id===d.id))??[];
  const actions=receipt.questions.map(q=>{const doc=snapshot?.documents.find(d=>d.id===q.id);return doc?latestSavedAnswer(doc).action:'回答';});
  const answered=actions.filter(action=>action==='回答').length,issues=actions.filter(action=>action==='前提不成立').length,deferred=other.length+actions.filter(action=>action==='暂缓').length;
  if(!snapshot)return `已答 ${answered}，暂缓 ${deferred}${issues?`，问题反馈 ${issues}`:''}。请从策问重新复制读取入口。`;
  const refs=answerContextRefs(receipt,snapshot),version=Number(/^@a(\d+)/.exec(refs[0])![1]);
  return `${snapshot.project.name} V${version}：已答 ${answered}，暂缓 ${deferred}${issues?`，问题反馈 ${issues}`:''}。`;
}
