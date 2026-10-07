import { fromMarkdown } from 'mdast-util-from-markdown';
import type { ProjectDocument } from './model.ts';
import { readHeader } from './markdown.ts';
import { setMetadata } from './editing.ts';

/** 发题入口共用简洁编写规范，模型无需依赖额外安装的 Skill 才能获知边界。 */
export const questionAuthoringRules='问题标题直接描述具体设计问题，不加 Q编号、P等级。背景只解释已有依据与具体未知，不重复分类、登记范围、入库目的、来源路径或软件操作说明；来源和轮次使用工具字段关联。每题确认一个明确边界，选项说明收益与代价，不预选，不将自定义回答、暂缓、问题反馈写成设计选项；这些操作由界面提供。没有明确摘录时不创建空锚点，不能编造来源身份。';

/** 同一题的背景、选项和回答共用一次语法解析；缓存只含原文投影，不保存或修改用户答案。 */
type QuestionContent = { metadata: Record<string, unknown>; bodyOffset: number; headings: { title: string; depth: number; start: number; end: number }[] };
const questionContentCache = new Map<string, QuestionContent>();
let questionContentCharacters = 0;
function questionContent(text: string): QuestionContent {
  const cached = questionContentCache.get(text);
  if (cached) return cached;
  const { metadata, body, bodyOffset } = readHeader(text);
  const headings = fromMarkdown(body).children.filter(node => node.type === 'heading').map(node => ({ title: node.children.map(child => 'value' in child ? child.value : '').join('').trim(), depth: node.depth, start: node.position!.start.offset!, end: node.position!.end.offset! }));
  const value = { metadata, bodyOffset, headings };
  // 输入产生的新正文按文本键失效；数量和总字符均有上限，长时间编辑不会无限积累旧稿。
  if (text.length <= 1_000_000) {
    questionContentCache.set(text, value); questionContentCharacters += text.length;
    while (questionContentCache.size > 128 || questionContentCharacters > 1_000_000) {
      const oldest = questionContentCache.keys().next().value!;
      questionContentCache.delete(oldest); questionContentCharacters -= oldest.length;
    }
  }
  return value;
}

/** 问题表单从普通 Markdown 章节读取；未知段落继续保留在原文中。 */
export function section(text: string, title: string) {
  const { bodyOffset, headings } = questionContent(text);
  const index = headings.findIndex(node => node.title === title);
  if (index < 0) return { text: '', start: text.length, end: text.length };
  const heading = headings[index];
  const next = headings.slice(index + 1).find(node => node.depth <= heading.depth);
  const start = bodyOffset + heading.end, end = next ? bodyOffset + next.start : text.length;
  return { text: text.slice(start, end).trim(), start, end };
}
export function inquiry(document: ProjectDocument) {
  const { metadata } = questionContent(document.text);
  const options = section(document.text, '可选方案').text.split('\n').filter(line => /^\s*-\s+[A-Z][：:]/.test(line)).map(line => line.replace(/^\s*-\s+/, '').trim());
  return { id: document.id, title: document.title, background: section(document.text, '问题背景').text, options, multiple: metadata.mode === 'multiple', follows: typeof metadata.follows === 'string' ? metadata.follows : '', condition: typeof metadata.condition === 'string' ? metadata.condition : '', status: String(metadata.status ?? 'open'), round: typeof metadata.round === 'string' ? metadata.round : '未分轮次', previous: section(document.text, '用户原始回答').text, interpretation: section(document.text, '模型解释').text, decision: section(document.text, '决定记录').text, baseRevision: typeof metadata.baseRevision === 'string' ? metadata.baseRevision : undefined };
}
/** 作答标题只保留问题描述；旧题中的编号与优先级仍保留在正式 Markdown 中。 */
export function questionDisplayTitle(title: string): string {
  return title.replace(/^Q\d+\s*[·•.、]\s*/i, '').replace(/^P\d+\s*[|｜:：]\s*/i, '').trim() || title;
}
/** 旧题的登记范围、入库说明与来源清单属于协作信息，作答区仅呈现设计背景。 */
export function questionDisplayBackground(background: string): string {
  return background.split('\n').filter(line => !/^\s*(?:本组登记范围[:：]|本次入库只|所属设计文档[:：]|后续按重要程度)/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** 首版条件题支持“前题已回答”及“选择指定方案”，原文仍保留供独立阅读。 */
export function questionAvailable(document: ProjectDocument, documents: ProjectDocument[]) {
  const metadata = questionContent(document.text).metadata;
  const when = metadata.when as { questionId?: string; option?: string } | undefined;
  const previousId = when?.questionId ?? (typeof metadata.follows === 'string' ? metadata.follows : undefined);
  if (!previousId) return { active: true, reason: '', previousId: '', previousTitle: '' };
  const previous = documents.find(doc => doc.id === previousId && doc.type === 'question');
  // 条件身份保留在数据中；界面使用可读题名并据此跳转，缺失前题不生成失效入口。
  if (!previous) return { active: false, reason: '前题已移除，请调整题目的关联。', previousId: '', previousTitle: '' };
  const previousTitle = questionDisplayTitle(previous.title);
  const answer = previous ? section(previous.text, '用户原始回答').text.split('### 回答 ').at(-1)! : '';
  const answered = Boolean(previous && section(previous.text, '用户原始回答').text.includes('### 回答 ') && answer.includes('- 作答方式：回答'));
  return { active: answered && (!when?.option || answer.includes(`  - ${when.option}`)), reason: when?.option ? `前题“${previousTitle}”选择“${when.option}”后可答` : `前题“${previousTitle}”回答后可答`, previousId, previousTitle };
}
/** 改答以新记录追加；用户原话与模型解释永远不共用一个可覆盖的字段。 */
export function answerQuestion(document: ProjectDocument, answer: { id: string; choices: string[]; text: string; action: string; revision: string | null; supersedes?: string }) {
  const existing = section(document.text, '用户原始回答');
  const quote = answer.text.split('\n').map(line => `> ${line}`).join('\n');
  const entry = `\n\n### 回答 ${answer.id}\n\n- 时间：${new Date().toISOString()}\n- 作答基础修订：${answer.revision ?? '未建立'}\n- 作答方式：${answer.action}\n${answer.supersedes ? `- 替代回答：${answer.supersedes}\n` : ''}- 选择及当时原文：\n${answer.choices.map(choice => `  - ${choice}`).join('\n') || '  - 无预设选项'}\n\n用户自定义原话：\n\n${quote || '> 未填写自定义文本。'}\n\n`;
  const prefix = existing.text === '尚未回答。' ? document.text.slice(0, existing.start) : document.text.slice(0, existing.end);
  const text = prefix + entry + document.text.slice(existing.end);
  return setMetadata(text, { status: answer.action === '暂缓' ? 'open' : 'answered' });
}
