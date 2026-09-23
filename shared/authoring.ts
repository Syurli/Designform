import { fromMarkdown } from 'mdast-util-from-markdown';
import { readHeader } from './markdown.ts';
import type { KnowledgeGroup } from './model.ts';

/** 常见设计领域只是可选目录，不自动生成文档或预设游戏规则。 */
export const categoryPresets: KnowledgeGroup[] = [
  ['experience','玩法与体验','#EBC58D'],['controls','操控与镜头','#7CBFFF'],['combat','战斗与技能','#ED9FAD'],
  ['growth','角色与成长','#B5A3F5'],['world','世界与关卡','#79D9C3'],['story','任务与叙事','#CBA6E9'],
  ['items','物品与装备','#C8BF7D'],['economy','资源与经济','#A6C981'],['ai','AI 与行为','#78BED0'],
  ['interface','界面与引导','#E5A780'],['feedback','音画与反馈','#DA9AC7'],['progress','存档与进程','#9FAED6'],
  ['network','联机与社交','#81C9BD'],['operations','运营与商业化','#C9AB82'],
].map(([id,label,color]) => ({ id: `system-${id}`, label, color }));

/** 正文投影只切出首个真实一级标题，保留其余字节和未知 Markdown。 */
export function writingParts(text: string) {
  const header = readHeader(text), heading = fromMarkdown(header.body).children.find(node => node.type === 'heading' && node.depth === 1);
  const start = header.bodyOffset + (heading?.position?.start.offset ?? 0);
  const end = header.bodyOffset + (heading?.position?.end.offset ?? 0);
  const after = text.slice(end), space = /^\s*\n\s*\n/.exec(after)?.[0] ?? '';
  return { title: heading ? text.slice(start,end).replace(/^#\s+/, '') : '', prefix: text.slice(0, start), separator: space || '\n\n', body: heading ? after.slice(space.length) : header.body, hasTitle: !!heading };
}
/** 只在用户编辑时拼回原标题段，读写切换本身不改变底层文本。 */
export function replaceWriting(text: string, title: string, body: string) {
  const part = writingParts(text);
  return `${part.prefix}${part.hasTitle || title.trim() ? `# ${title.replace(/[\r\n]/g, ' ')}${part.separator}` : ''}${body}`;
}

export const writingOutlines: Record<string, string[]> = {
  通用设计: ['设计目标','玩家行为与反馈','规则与边界','待讨论'],
  战斗设计: ['战斗体验','玩家操作','对抗与反馈','异常与边界'],
  关卡设计: ['进入时的体验','路线与节奏','挑战与反馈','结束条件'],
  资源设计: ['设计目标','获得与消耗','取舍与反馈','待讨论'],
  游戏总纲: ['目标体验','核心循环','首版范围','尚未决定'],
};
