import type { ProjectSnapshot, ProjectDocument } from './model.ts';
import { readHeader } from './markdown.ts';
import { inquiry } from './inquiry.ts';

/** 开场白绑定成功提交，私有草稿与未提交文本不进入外发上下文。 */
export interface AnswerHandoff {
  projectId:string; requestId:string; revision:string|null; documentIds:string[];
  questions:{id:string;answerId:string;hash:string;round:string;questId?:string;roundId?:string}[];
}
export function questionRoundKey(doc:ProjectDocument):string {
  const m=readHeader(doc.text).metadata;
  return JSON.stringify([String(m.questId??''),String(m.roundId??inquiry(doc).round)]);
}
export function answerHandoff(snapshot:ProjectSnapshot,ids:string[],requestId:string,documentIds:string[]=[]):AnswerHandoff {
  return {projectId:snapshot.project.id,requestId,revision:snapshot.revision,documentIds,questions:ids.map(id=>{
    const doc=snapshot.documents.find(d=>d.id===id)!;const q=inquiry(doc),m=readHeader(doc.text).metadata;
    return {id,answerId:[...q.previous.matchAll(/### 回答 ([A-Za-z0-9_-]+)/g)].at(-1)?.[1]??'',hash:doc.hash,round:q.round,...(typeof m.questId==='string'?{questId:m.questId}:{}),...(typeof m.roundId==='string'?{roundId:m.roundId}:{})};
  })};
}

/** 普通问询与 Quest 共用分析边界；不能把复制动作当作下一轮授权。 */
export const answerAnalysisRules=`请先分析本轮原始回答，不要直接发布下一轮问题。
1. 通过 cewen_status 核对实际项目和修订，用 cewen_context 或 cewen_read_document 读取指定问题、用户原始回答及相关文档。有实际 Quest 时可以先用 cewen_quest_read 核对；普通文档不需要创建 Quest。读取失败请报告实际错误，不能假装已读取。
2. 如提交后已有改答或文档变化，列出差异后分析经核实的最新内容，不混用版本。无法判断的冲突先问我。只读取公开已保存内容，不读取 .cewen 或未提交草稿。
3. 分别整理“用户明确表达的内容、你的理解与推断、建议修改、待澄清事项”，关联对应问题／回答。保留条件和理由；未答、暂缓、前提不成立分别对待，不代答、不补选默认方案。
4. 有充分依据的文档修改可以用 cewen_propose 暂存候选，保留完整原始回答，携带实际修订和依赖哈希，由我在策问审核采纳。分析没有修改时不必创建提案。不自行批准、直接覆盖正式文档或改写历史。
5. 最后说明是否建议再开一轮、建议目标和少量关键议题，询问我“开始下一轮、先修正本轮理解，还是暂时结束？”，然后停止并等待我的明确回复。
6. 我明确同意前，不调用 cewen_publish_questions 或 cewen_quest_round，也不以其他写入方式创建下一轮。Quest 续轮工具同时写入新题，不能当作仅保存摘要的工具使用。复制开场白、提交答案、采纳提案均不等于同意续轮。
7. 我明确同意开始下一轮后，再核对修订，按已确认目标发布必要问题，关联来源与原问题，告知我回策问作答。每轮仍先分析再确认，不连续自行开轮。`;

export function answerHandoffContext(receipt:AnswerHandoff,snapshot?:ProjectSnapshot):string {
  const roundKeys=new Set(receipt.questions.map(q=>JSON.stringify([q.questId??'',q.roundId??q.round])));
  const other=snapshot?.documents.filter(d=>d.type==='question'&&roundKeys.has(questionRoundKey(d))&&!receipt.questions.some(q=>q.id===d.id))??[];
  return `本次提交项目：${receipt.projectId}\n提交请求：${receipt.requestId}\n成功提交修订：${receipt.revision??'无'}\n相关文档：${receipt.documentIds.join('、')||'以问题中的目标与锚点为准'}\n本次提交的问题与回答：\n${receipt.questions.map(q=>`- ${q.id} → ${q.answerId}；hash=${q.hash}；轮次=${q.round}${q.roundId?`；roundId=${q.roundId}`:''}${q.questId?`；questId=${q.questId}`:''}`).join('\n')}\n本轮其余问题（只含已保存状态）：\n${other.map(d=>`- ${d.id}：${inquiry(d).previous.includes('### 回答 ')?'此前有已提交回答，请核对最新记录':'尚未提交回答'}`).join('\n')||'无'}\n请把问题 ID 与相关文档 ID 明确传入读取范围，不用空范围读取整个项目。`;
}
