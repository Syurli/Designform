import type { ProjectSnapshot } from './model.ts';

/** 开场白模板为应用资源，输入和候选方向均不自动成为设计决定。 */
export const promptScenes = [
  ['start','从零构思','先澄清核心体验，再提出最多五个会影响方向的问题。'],
  ['import','导入已有策划','盘点用户提供的材料，提出文档映射，明确原文冲突与缺失，不擅自改写已有决定。'],
  ['connect','接入或恢复协作','验证策问的真实连接，并报告实际项目、修订和可用操作。'],
  ['write','完善专项设计','结合已有规则补充体验、操作、反馈、例子和边界，先形成可审阅的候选修改。'],
  ['inquiry','深挖一轮问询','依据当前设计发现关键缺口，给出有推荐理由和代价的选项，并保留自由回答、暂缓和否定前提。'],
  ['review','检查设计一致性','检查矛盾、缺失前提、重复规则和范围冲突，逐项说明依据、影响范围和建议。'],
  ['answers','根据回答继续迭代','读取用户原始回答与已确认决定，提出对应 DD 的修改；未采纳的建议仍保留为候选。'],
  ['handoff','版本复盘与交接','说明当前设计状态、指定版本差异、未决问题和下一步，让后续模型准确接续。'],
] as const;
export type PromptScene = typeof promptScenes[number][0];
export interface GameIdea { idea: string; genres: string[]; scope: string; gameplay: string[]; customGenre: string; customPlay: string; constraints: string; approach: string; platform?: string; team?: string; session?: string }
export const emptyIdea = (): GameIdea => ({ idea: '', genres: [], scope: '尚未确定', gameplay: [], customGenre: '', customPlay: '', constraints: '', approach: '先问我关键问题' });
/** 同一份设想同时用于手动创建和模型协作，保留“想尝试”语气。 */
export function ideaBrief(idea: GameIdea) {
  const genres = [...idea.genres,idea.customGenre].filter(Boolean), play = [...idea.gameplay,idea.customPlay].filter(Boolean);
  return [idea.idea.trim() ? `我的设想：${idea.idea.trim()}` : '游戏方向尚未明确。', `想尝试的类型：${genres.join('、') || '待讨论'}。`, `本轮目标：${idea.scope || '待讨论'}。`, `想尝试的玩法：${play.join('、') || '待讨论'}。`, `目标平台：${idea.platform || '待讨论'}；开发资源：${idea.team || '待讨论'}；单次体验时长：${idea.session || '待讨论'}。`, idea.constraints.trim() ? `补充条件（保留已定与待定的区别）：\n${idea.constraints.trim()}` : '具体预算、内容规模与制作周期尚未确定。'].join('\n\n');
}
export interface IntegrationInfo { mode: 'local' | 'web'; root?: string; launcher?: string; runtime?: string; skill?: string; guide?: string; url?: string }
/** 软件只提供已知真实入口，不凭网页地址或复制动作宣称 MCP 在线。 */
export function composePrompt(input: { scene: PromptScene; idea?: GameIdea; snapshot?: ProjectSnapshot; documentIds?: string[]; integration?: IntegrationInfo; extra?: string }) {
  const scene = promptScenes.find(scene => scene[0] === input.scene) ?? promptScenes[0], snapshot = input.snapshot;
  const documents = input.documentIds?.length ? snapshot?.documents.filter(doc => input.documentIds!.includes(doc.id)) : [];
  const context = snapshot ? `继续策问中的项目“${snapshot.project.name}”（身份 ${snapshot.project.id}）。当前查看修订：${snapshot.revisionLabel ?? '尚无版本'} / ${snapshot.revision ?? '无'}${snapshot.historical ? '，此为只读历史，请先确认当前工作稿，不能回写历史。' : '。'}\n${input.integration?.mode === 'local' ? `项目文件夹：${snapshot.project.path}\n` : '请读取我另行提供的项目文件或上下文包；不要假定能访问我的电脑。\n'}${documents?.length ? `本轮聚焦：\n${documents.map(doc => `- ${doc.title}（${doc.id}，${doc.path}）`).join('\n')}\n需要更多背景时，再读取关联文档。` : '先读取 PROJECT.md、公开文档目录及总纲；没有总纲时先确认设想，不虚构文档。'}` : '目前尚未创建项目，请先讨论；等方向明确后再整理项目，不擅自创建本地文件夹。';
  const integration = input.integration?.mode === 'local' ? `协作 Skill：${input.integration.skill}\n独立接入说明：${input.integration.guide ?? '请读取 Skill 中的接入引用'}\n${input.integration.launcher ? `MCP 启动入口：${input.integration.launcher}` : `MCP 运行文件：${input.integration.runtime}（需要本机 Node 运行环境）`}\n运行中的策问服务：${input.integration.url}。先检查是否已有策问工具；未接入时依据接入 Skill 和当前客户端能力完成配置。需要用户在宿主确认时说明具体步骤。无法访问本机或注册 MCP 时明确告知，改用用户提供的文件/上下文包。不要让用户手改 JSON，也不要把读取文件当成持续 MCP 连接。` : '使用用户主动提供的公开 Markdown 或上下文包协作。若尚未提供材料，明确指出需要的文件；本机路径和网页网址本身不赋予文件访问能力。';
  return [`我希望与你一起使用策问完成：${scene[1]}。`, input.idea ? ideaBrief(input.idea) : '', context, input.idea ? `本轮协作方式：${input.idea.approach}。` : '', `请完成：${scene[2]}`, input.extra?.trim() ? `我的补充要求：\n${input.extra.trim()}` : '', integration, '协作规则：区分已确定条件、尝试方向和未决问题；不替我作答，不将未选方案当成决定。推荐要说明理由与代价。正文优先满足阅读，用自然文句链接相关 DD，将功能字段和关系索引后置。保留稳定身份、原始回答与历史；修改先形成可核对的提案，按我授权的范围保存并记录版本。只使用公开或我明确分享的内容，不读取私人笔记。'].filter(Boolean).join('\n\n');
}
