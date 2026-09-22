import { fromMarkdown } from 'mdast-util-from-markdown';
import type { ProjectDocument } from './model.ts';
import { readHeader } from './markdown.ts';
import { setMetadata } from './editing.ts';

/** 问题表单从普通 Markdown 章节读取；未知段落继续保留在原文中。 */
export function section(text: string, title: string) {
  const { body, bodyOffset } = readHeader(text), nodes = fromMarkdown(body).children;
  const index = nodes.findIndex(node => node.type === 'heading' && node.children.map(child => 'value' in child ? child.value : '').join('').trim() === title);
  if (index < 0) return { text: '', start: text.length, end: text.length };
  const heading = nodes[index];
  const next = nodes.slice(index + 1).find(node => node.type === 'heading' && heading.type === 'heading' && node.depth <= heading.depth);
  const start = bodyOffset + heading.position!.end.offset!, end = next ? bodyOffset + next.position!.start.offset! : text.length;
  return { text: text.slice(start, end).trim(), start, end };
}
export function inquiry(document: ProjectDocument) {
  const { metadata } = readHeader(document.text);
  const options = section(document.text, '可选方案').text.split('\n').filter(line => /^\s*-\s+[A-Z][：:]/.test(line)).map(line => line.replace(/^\s*-\s+/, '').trim());
  return { id: document.id, title: document.title, background: section(document.text, '问题背景').text, options, multiple: metadata.mode === 'multiple', follows: typeof metadata.follows === 'string' ? metadata.follows : '', condition: typeof metadata.condition === 'string' ? metadata.condition : '', status: String(metadata.status ?? 'open'), round: typeof metadata.round === 'string' ? metadata.round : '未分轮次', previous: section(document.text, '用户原始回答').text, interpretation: section(document.text, '模型解释').text, decision: section(document.text, '决定记录').text, baseRevision: typeof metadata.baseRevision === 'string' ? metadata.baseRevision : undefined };
}
/** 首版条件题支持“前题已回答”及“选择指定方案”，原文仍保留供独立阅读。 */
export function questionAvailable(document: ProjectDocument, documents: ProjectDocument[]) {
  const metadata = readHeader(document.text).metadata;
  const when = metadata.when as { questionId?: string; option?: string } | undefined;
  const previousId = when?.questionId ?? (typeof metadata.follows === 'string' ? metadata.follows : undefined);
  if (!previousId) return { active: true, reason: '' };
  const previous = documents.find(doc => doc.id === previousId && doc.type === 'question');
  const answer = previous ? section(previous.text, '用户原始回答').text.split('### 回答 ').at(-1)! : '';
  const answered = Boolean(previous && section(previous.text, '用户原始回答').text.includes('### 回答 ') && answer.includes('- 作答方式：回答'));
  return { active: answered && (!when?.option || answer.includes(`  - ${when.option}`)), reason: when?.option ? `前题 ${previousId} 选择“${when.option}”后可答` : `前题 ${previousId} 回答后可答` };
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
