import type { ProjectDocument, ProjectSnapshot } from './model.ts';
import type { AnswerHandoff } from './answer-handoff.ts';
import { readHeader } from './markdown.ts';
import { inquiry, questionDisplayBackground, questionDisplayTitle } from './inquiry.ts';
import { questionSources } from './question-sources.ts';
import { rewriteLinks, linkTarget } from './links.ts';
import { fromMarkdown } from 'mdast-util-from-markdown';

/** 短号仅用于读取定位，不是内容校验；遇到碰撞由服务拒绝猜测。 */
function shortNumber(value: string): string {
  let number = 2166136261;
  for (let index = 0; index < value.length; index++) number = Math.imul(number ^ value.charCodeAt(index), 16777619);
  return (number >>> 0).toString(36);
}
/** 不改写公开身份和历史文件，项目短号在各次启动中保持一致。 */
export const compactProjectRef = (id: string): string => 'P' + shortNumber(id);
/** 普通问询和 Quest 按各自已保存的轮次身份分组。 */
export function questionRoundKey(doc: ProjectDocument): string {
  const metadata = readHeader(doc.text).metadata;
  return JSON.stringify([String(metadata.questId ?? ''), String(metadata.roundId ?? inquiry(doc).round)]);
}
const ordered = (documents: ProjectDocument[]) => [...documents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** 连续题序合并为范围，只在当前汇总不是完整轮次时携带。 */
function ranges(numbers: number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < numbers.length; index++) {
    const first = numbers[index]; let last = first;
    while (numbers[index + 1] === last + 1) last = numbers[++index];
    parts.push(first === last ? String(first) : `${first}-${last}`);
  }
  return parts.join(',');
}
/** 引用固定保存版本，后续改答不会悄悄混入已复制的这一轮。 */
export function answerContextRefs(receipt: AnswerHandoff, snapshot: ProjectSnapshot): string[] {
  const version = Number(/^V(\d+)$/.exec(receipt.revisionLabel ?? snapshot.revisionLabel ?? '')?.[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('回答尚无保存版本，请重新复制开场白。');
  const keys = [...new Set(receipt.questions.map(question => JSON.stringify([question.questId ?? '', question.roundId ?? question.round])))];
  return keys.map(key => {
    const questions = ordered(snapshot.documents.filter(doc => doc.type === 'question' && questionRoundKey(doc) === key));
    const wanted = receipt.roundQuestionIds ? new Set(receipt.roundQuestionIds) : new Set(questions.filter(doc => doc.status !== 'archived').map(doc => doc.id));
    const selected = questions.map((doc, index) => wanted.has(doc.id) ? index + 1 : 0).filter(Boolean);
    if (!selected.length) throw new Error('本轮问题范围为空，请重新复制开场白。');
    const defaults = questions.map((doc, index) => doc.status !== 'archived' ? index + 1 : 0).filter(Boolean);
    const scope = selected.join(',') === defaults.join(',') ? '' : '~' + ranges(selected);
    return `@a${version}.${shortNumber(key)}${scope}`;
  });
}
/** 旧 MCP 的 documentIds 已接受任意非空字符串，读取短号不需要重启客户端。 */
export function parseAnswerContextRef(value: string) {
  const match = /^@a([1-9]\d*)\.([a-z0-9]{1,7})(?:~([\d,-]+))?(?:\/D([1-9]\d*))?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('回答读取引用无效，请重新复制开场白。');
  return { version: Number(match[1]), round: match[2], scope: match[3], document: match[4] ? Number(match[4]) : undefined, packet: value.replace(/\/D\d+$/, '') };
}
/** 仅取最后一次已保存原话；旧记录保留在文件中，需要时另行读取历史。 */
export function latestSavedAnswer(doc: ProjectDocument) {
  const previous = inquiry(doc).previous;
  const heading = [...previous.matchAll(/^### 回答 [A-Za-z0-9_-]+\s*$/gm)].at(-1);
  if (!heading) return { action: '暂缓', choices: [] as string[], text: '' };
  const last = previous.slice(heading.index! + heading[0].length);
  const action = /- 作答方式：([^\r\n]+)/.exec(last)?.[1].trim() ?? '回答';
  const choices = [...last.matchAll(/^  - (.+)$/gm)].map(match => match[1].trim()).filter(choice => choice !== '无预设选项');
  const text = (last.split('用户自定义原话：')[1] ?? '').split('\n').filter(line => /^>/.test(line)).map(line => line.replace(/^> ?/, '').replace(/\r$/, '')).join('\n').trim();
  return { action, choices, text: text === '未填写自定义文本。' ? '' : text };
}
/** 将正文内已知文档链接投影为短号；不修改原文，不移除设计正文。 */
function compactLinks(text: string, source: string, snapshot: ProjectSnapshot, refs: Map<string, string>): string {
  const mapping=new Map(snapshot.documents.filter(doc=>refs.has(doc.id)).map(doc=>[doc.path,refs.get(doc.id)!]));
  return rewriteLinks(text,source,'context.md',mapping);
}
/** 候选正文中的短链接还原为真实相对路径，代码示例和外部链接保持原样。 */
export function expandAnswerLinks(text:string,owner:ProjectDocument,snapshot:ProjectSnapshot,value:string):string{
  const {refs}=answerContextSelection(snapshot,value),mapping=new Map<string,string>();
  for(const doc of snapshot.documents){const ref=refs.get(doc.id);if(ref)mapping.set(linkTarget(owner.path,ref)!.path,doc.path);}
  return rewriteLinks(text,owner.path,owner.path,mapping);
}
/** 仅省略真实定位节点，代码块中演示的同名标记不参与过滤。 */
function withoutPositionMarkers(body:string):string{
  const spans=fromMarkdown(body).children.filter(node=>['html','paragraph'].includes(node.type)&&node.position).map(node=>({start:node.position!.start.offset!,end:node.position!.end.offset!})).filter(span=>/^(?:<!-- cewen:block [^\n]+ -->|<a\s+id=["'][A-Za-z0-9_-]+["']\s*>\s*<\/a>)$/.test(body.slice(span.start,span.end).trim()));
  for(const span of spans.sort((a,b)=>b.start-a.start))body=body.slice(0,span.start)+body.slice(span.end);
  return body.replace(/\n{3,}/g,'\n\n').trim();
}
/** Q、D 短号都绑定同一个版本与范围，读取和提案共用定位结果。 */
export function answerContextSelection(snapshot: ProjectSnapshot, value: string) {
  const selector = parseAnswerContextRef(value);
  const keys = [...new Set(snapshot.documents.filter(doc => doc.type === 'question').map(questionRoundKey))].filter(key => shortNumber(key) === selector.round);
  if (keys.length !== 1) throw new Error(keys.length ? '轮次短号存在歧义，请重新复制开场白。' : '此保存版本没有指定轮次。');
  const all = ordered(snapshot.documents.filter(doc => doc.type === 'question' && questionRoundKey(doc) === keys[0]));
  let questions = all.filter(doc => doc.status !== 'archived');
  if (selector.scope) {
    const indices = new Set<number>();
    for (const part of selector.scope.split(',')) {
      const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(part);
      const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
      if (!match || start > end || end > all.length) throw new Error('本轮题序范围无效。');
      for (let index = start; index <= end; index++) indices.add(index);
    }
    questions = all.filter((_doc, index) => indices.has(index + 1));
  }
  const documents = ordered(snapshot.documents.filter(doc => doc.type !== 'question' && !doc.id.startsWith('unidentified:')));
  const refs = new Map(documents.map((doc, index) => [doc.id, `D${index + 1}`]));
  questions.forEach((doc, index) => refs.set(doc.id, `Q${index + 1}`));
  return {selector,questions,documents,refs};
}
/** 小包只返回原始问答；正文按 D 短号追加读取，避免整项目图谱与哈希反复传输。 */
export function compactAnswerContext(snapshot: ProjectSnapshot, value: string): string {
  const {selector,questions,documents,refs}=answerContextSelection(snapshot,value);
  const header = `${snapshot.project.name} V${selector.version}`;
  if (selector.document) {
    const document = documents[selector.document - 1];
    if (!document) throw new Error('此保存版本没有指定文档短号。');
    const body = withoutPositionMarkers(readHeader(document.text).body);
    return `${header} D${selector.document}\n${compactLinks(body, document.path, snapshot, refs)}`;
  }
  const sourceIds = new Set(questions.flatMap(doc => questionSources(snapshot, doc)));
  const directory = documents.filter(doc => sourceIds.has(doc.id)).map(doc => `${refs.get(doc.id)} ${doc.title}`).join('\n');
  const entries = questions.map((doc, index) => {
    const question = inquiry(doc), answer = latestSavedAnswer(doc), sources = questionSources(snapshot, doc).map(id => refs.get(id)).filter(Boolean);
    const background = questionDisplayBackground(question.background);
    const when=readHeader(doc.text).metadata.when as {questionId?:string;option?:string}|undefined;
    const precedingId=when?.questionId??question.follows,preceding=snapshot.documents.find(item=>item.id===precedingId);
    const condition=when?.option?`选择“${when.option}”后可答`:question.condition||(precedingId?'前题回答后可答':'');
    return [`Q${index + 1} ${questionDisplayTitle(doc.title)}${sources.length ? ' [' + sources.join(',') + ']' : ''}`, background, answer.action === '暂缓' ? '暂缓' : answer.action === '前提不成立' ? '题目有问题' : '', answer.action === '回答' && answer.choices.length ? '选择：' + answer.choices.join('\n') : '', answer.text ? '原话：' + answer.text : '', preceding ? '前题：' + (refs.get(preceding.id) ?? preceding.title) : '', condition ? '条件：' + condition : ''].filter(Boolean).map(text => compactLinks(text, doc.path, snapshot, refs)).join('\n');
  });
  return [header, `正文：documentIds=["${selector.packet}/D数字"]；Q/D 仅为本包短号。\n提案可用 baseRevision="${selector.packet}"、path="D数字"、baseHash=null、dependencies={}，软件自动定位。`, directory, ...entries].filter(Boolean).join('\n\n');
}
