import type { LlmConnectionState, ProjectSnapshot } from './model.ts';
import { documentAliases } from './document-aliases.ts';
import { readHeader } from './markdown.ts';
import { parseDocumentBlocks } from './document-blocks.ts';
import { parseDesignBlock } from './design-blocks.ts';
import { countDocumentContent } from './content-statistics.ts';

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
  ['organize','整理分类与别名','核对现有分类和文档别名，给出可审阅的归属、命名与链接候选；不凭同名自动改写引用。'],
  ['dialogue','检查对白分支','核对起点、选项目标、不可达节点与有意循环，提出保留稳定身份的修订建议。'],
  ['annotations','汇总共享注释','只汇总本轮文档的项目共享注释，按锚点与正文核对，不推断未分享的私人批注。'],
  ['palette','比较设计色板','比较文档内的正式色板、色彩意图和已提供的源图信息，给出可审阅的调整建议。'],
  ['content-review','复盘内容变化','结合当前已保存内容统计与指定版本差异，定位新增、删除和待处理条目。'],
] as const;
export type PromptScene = typeof promptScenes[number][0];
export interface GameIdea { idea: string; genres: string[]; goals: string[]; gameplay: string[]; platforms: string[]; customGenre: string; customGoal: string; customPlay: string; customPlatform: string; constraints: string; approach: string; team?: string; session?: string }
export const emptyIdea = (): GameIdea => ({ idea: '', genres: [], goals: [], gameplay: [], platforms: [], customGenre: '', customGoal: '', customPlay: '', customPlatform: '', constraints: '', approach: '先问我关键问题' });
/** 同一份设想同时用于手动创建和模型协作，保留“想尝试”语气。 */
export function ideaBrief(idea: GameIdea) {
  const words = (values: string[], custom: string) => [...new Set([...values, custom.trim()].filter(Boolean))].join('、') || '待讨论';
  return [idea.idea.trim() ? `我的设想：${idea.idea.trim()}` : '游戏方向尚未明确。', `想尝试的类型：${words(idea.genres, idea.customGenre)}。`, `本轮目标：${words(idea.goals, idea.customGoal)}。`, `想尝试的玩法：${words(idea.gameplay, idea.customPlay)}。`, `目标平台：${words(idea.platforms, idea.customPlatform)}；开发资源：${idea.team || '待讨论'}；单次体验时长：${idea.session || '待讨论'}。`, idea.constraints.trim() ? `补充条件（保留已定与待定的区别）：\n${idea.constraints.trim()}` : '具体预算、内容规模与制作周期尚未确定。'].join('\n\n');
}
export interface IntegrationInfo { mode: 'local' | 'web' | 'unknown'; root?: string; launcher?: string; runtime?: string; skill?: string; guide?: string; url?: string }

/** 只从公开快照生成任务线索，私人工作区、草稿和预演状态不进入开场白。 */
function publicTaskContext(scene: PromptScene, snapshot: ProjectSnapshot, documents: ProjectSnapshot['documents']) {
  if (scene === 'organize') {
    const groups = snapshot.groups.map(group => `${group.label}（${group.id}）`).join('、') || '尚无分类';
    const aliases = documents.map(doc => {
      try { const names = documentAliases(readHeader(doc.text).metadata.aliases); return names.length ? `${doc.title}：${names.join('、')}` : ''; }
      catch { return ''; }
    }).filter(Boolean);
    return `现有公开分类：${groups}。${aliases.length ? `\n本轮文档别名：\n${aliases.slice(0, 20).map(item => `- ${item}`).join('\n')}` : ''}\n主要分类写在文档 system；正文链接与手工设计关系另有来源。目录顺序只帮助浏览，不表示依赖。`;
  }
  if (scene === 'dialogue' || scene === 'palette') {
    const kind = scene === 'dialogue' ? 'dialogue' : 'palette';
    const blocks = documents.flatMap(doc => {
      try { return parseDocumentBlocks(doc.text).filter(block => block.type === 'code').flatMap(block => {
        const match = /^(?:`{3,}|~{3,})(cewen-dialogue|cewen-palette)\s*\r?\n([\s\S]*?)\r?\n(?:`{3,}|~{3,})\s*$/.exec(block.source.trim());
        if (!match) return [];
        try { const value = parseDesignBlock(match[1], match[2]); return value?.kind === kind ? [`${doc.title}：${value.title}（${value.id}）`] : []; } catch { return [`${doc.title}：存在需核对的 ${match[1]} 块`]; }
      }); } catch { return []; }
    });
    const summary = blocks.length ? blocks.slice(0, 20).map(item => `- ${item}`).join('\n') : '所选文档未检出对应设计块，请先核对文件，不臆造内容。';
    return scene === 'dialogue' ? `已保存对白块：\n${summary}\n对白仍属于原文档；正文内保留可点击选项预览，独立编辑页修改同一块。节点坐标只表示编辑摆放，跳转依显式连接字段；不执行任意脚本。` : `已保存色板块：\n${summary}\n正式色板与图片提取候选分开；没有源图或占比时不臆造统计。游戏美术色板不改变工作台分类色。`;
  }
  if (scene === 'annotations') {
    const paths = documents.flatMap(doc => [`docs/annotations/${doc.id}.md`, `docs/annotations/${doc.id}.ink.json`, `docs/layouts/${doc.id}.json`]).filter(path => snapshot.files?.[path] || snapshot.companions?.[path]);
    return `本轮已存在的公开注释与布局文件：${paths.length ? `\n${paths.slice(0, 30).map(path => `- ${path}`).join('\n')}` : '暂无。'}\n只分享这些公开文件；.cewen 中的私人注释、个人镜头和草稿不在本轮上下文。先按锚点核对原文，再汇总需处理的意见。`;
  }
  if (scene === 'content-review') {
    let skipped = 0;
    const totals = documents.reduce((sum, doc) => {
      try {
        const item = countDocumentContent(doc.text);
        return { characters: sum.characters + item.characters, images: sum.images + item.imageReferences, dialogue: sum.dialogue + item.dialogueNodes, choices: sum.choices + item.dialogueChoices, palettes: sum.palettes + item.palettes };
      } catch { skipped++; return sum; }
    }, { characters: 0, images: 0, dialogue: 0, choices: 0, palettes: 0 });
    return `当前已保存范围：${documents.length} 份文档${skipped ? `，其中 ${skipped} 份解析失败待核对` : ''}；可解析正文的可读字符 ${totals.characters}，图片引用 ${totals.images}，对白节点 ${totals.dialogue}、选项 ${totals.choices}，色板 ${totals.palettes}。统计不含未保存草稿，图片引用不等于去重附件数；版本差异请读取实际历史，不以净字符差冒充增删明细。`;
  }
  return '';
}
/** 连接入口只处理工具接入，不把游戏构思或文档修改混入这次任务。 */
export function composeConnectionPrompt(snapshot?: ProjectSnapshot, integration?: IntegrationInfo, connections?: LlmConnectionState) {
  if(integration?.mode !== 'local')return [integration?.mode === 'web' ? '我正在使用策问网页版，希望与你通过文件协作。' : '策问的接入信息暂时不可用，请先通过我提供的文件协作。',snapshot?`当前项目：${snapshot.project.name}，查看版本：${snapshot.revisionLabel??'未记录'}。`:'目前尚未选择项目。',integration?.mode === 'web' ? '网页版没有直接提供 MCP 服务。请先告诉我本轮需要提供哪些公开 Markdown 或上下文包；我提供后再读取，不假定能访问我的本机文件。' : '目前无法核实 MCP 服务位置或连接状态。请告诉我需要哪些公开 Markdown 或上下文包；不要把已读文件当成 MCP 连接。','现在先确认协作方式，具体策划任务由我下一步提出。'].join('\n\n');
  const live = connections?.connections.filter(connection => connection.status === 'connected') ?? [];
  return [live.length ? '策问检测到有效 MCP 客户端心跳，请检查当前对话能否使用现有策问工具；本轮只核对连接。' : '请帮我接入本机正在运行的策问 MCP，本轮只完成连接检查。',`服务地址：${integration.url}\n${integration.launcher?`MCP 启动入口：${integration.launcher}`:`MCP 运行文件：${integration.runtime}（使用本机 Node.js）`}\n接入说明：${integration.guide}\n协作 Skill：${integration.skill}`,snapshot?`请核对项目“${snapshot.project.name}”（${snapshot.project.id}）。\n项目目录：${snapshot.project.path}\n我当前查看：${snapshot.revisionLabel??'未记录'}${snapshot.historical?'（历史只读）':''}。`:'目前尚未选择项目，只需核对工具连通，等我指定项目。',live.length?'先尝试当前对话已有的策问工具；其他客户端的心跳不保证这场对话也已接入。若工具不可用，再按接入说明配置。':`当前${connections?'没有有效客户端心跳；过期或断开的连接也不算在线':'无法核实心跳状态'}。先检查是否已有策问工具；若没有，读取上面的接入说明，按当前客户端支持的方式配置。需要我在客户端确认或重启时，告诉我具体操作，不要求我自行猜填配置 JSON。`,`通过 cewen_projects 核对工具连通${snapshot?'和项目身份':''}。明确知道实际模型名称时调用 cewen_identify，不确定时报告未知。最后简短告诉我连接结果、实际模型名称${snapshot?'和项目是否匹配':''}。`,'如果无法访问本机或注册 MCP，请直接说明原因，不把读取文件当成 MCP 已连接。本轮不修改策划、发布问询或创建版本；后续策划任务由我另行提出。'].join('\n\n');
}
/** 软件只提供已知真实入口，不凭网页地址或复制动作宣称 MCP 在线。 */
export function composePrompt(input: { scene: PromptScene; idea?: GameIdea; snapshot?: ProjectSnapshot; documentIds?: string[]; integration?: IntegrationInfo; connections?: LlmConnectionState; extra?: string }) {
  if(input.scene==='connect')return composeConnectionPrompt(input.snapshot,input.integration,input.connections)+(input.extra?.trim()?`\n\n补充要求：${input.extra.trim()}`:'');
  const scene = promptScenes.find(scene => scene[0] === input.scene) ?? promptScenes[0], snapshot = input.snapshot;
  const documents = input.documentIds?.length ? snapshot?.documents.filter(doc => input.documentIds!.includes(doc.id)) : [];
  const taskDocuments = snapshot ? documents?.length ? documents : snapshot.documents : [];
  const taskContext = snapshot ? publicTaskContext(input.scene, snapshot, taskDocuments) : '';
  const context = snapshot ? `继续策问中的项目“${snapshot.project.name}”（身份 ${snapshot.project.id}）。当前查看修订：${snapshot.revisionLabel ?? '尚无版本'} / ${snapshot.revision ?? '无'}${snapshot.historical ? '，此为只读历史，请先确认当前工作稿，不能回写历史。' : '。'}\n${input.integration?.mode === 'local' ? `项目文件夹：${snapshot.project.path}\n` : '请读取我另行提供的项目文件或上下文包；不要假定能访问我的电脑。\n'}${documents?.length ? `本轮聚焦：\n${documents.map(doc => `- ${doc.title}（${doc.id}，${doc.path}）`).join('\n')}\n需要更多背景时，再读取关联文档。` : '工具接入后读取 PROJECT.md、公开文档目录及总纲；没有工具时先向我索取公开材料。没有总纲时先确认设想，不虚构文档。'}` : '目前尚未创建项目，请先讨论；等方向明确后再整理项目，不擅自创建本地文件夹。';
  const live = input.connections?.connections.filter(connection => connection.status === 'connected') ?? [];
  const projectSeen = snapshot && live.some(connection => connection.projectId === snapshot.project.id);
  const integration = input.integration?.mode === 'local' ? [
    `协作 Skill：${input.integration.skill}\n独立接入说明：${input.integration.guide ?? '请读取 Skill 中的接入引用'}\n${input.integration.launcher ? `MCP 启动入口：${input.integration.launcher}` : `MCP 运行文件：${input.integration.runtime}（需要本机 Node 运行环境）`}\n策问服务地址：${input.integration.url}。`,
    live.length ? `策问目前检测到 ${live.length} 个有效 MCP 客户端心跳${snapshot ? projectSeen ? '，其中已有客户端访问此项目' : '，但尚未核实客户端访问此项目' : '；此时尚未创建项目，无需核对项目身份'}。请先检查你当前对话是否已有 cewen_projects 等策问工具；有工具就直接用现有连接${snapshot ? '，通过 cewen_projects 核对项目身份后读取当前项目' : '，通过 cewen_projects 核对工具可用，先讨论设想，等我创建项目后再核对项目身份'}。应用检测到的连接可能属于另一个客户端，不能代替你在当前对话中检查。` : `策问目前${input.connections ? '没有有效 MCP 客户端心跳，旧连接已断开或过期时也算未连接' : '暂时无法核实 MCP 连接状态'}。先检查你当前对话是否已有策问工具；若没有，请读取上述接入说明，按当前客户端支持的方式配置 MCP。需要我在客户端确认或重启时，告诉我具体操作，不要求我手改配置 JSON。接入后调用 cewen_projects 验证${snapshot ? '项目身份' : '工具连通；目前尚未创建项目，先讨论设想'}。`,
    '若无法访问本机或注册 MCP，请明确说明，改用我主动提供的公开文件或上下文包。读取文件、复制开场白或仅看到服务地址都不等于 MCP 已连接。'
  ].join('\n') : '使用用户主动提供的公开 Markdown 或上下文包协作。若尚未提供材料，明确指出需要的文件；本机路径和网页网址本身不赋予文件访问能力。';
  return [`我希望与你一起使用策问完成：${scene[1]}。`, input.idea ? ideaBrief(input.idea) : '', context, taskContext, input.idea ? `本轮协作方式：${input.idea.approach}。` : '', `请完成：${scene[2]}`, input.extra?.trim() ? `我的补充要求：\n${input.extra.trim()}` : '', integration, '协作规则：区分已确定条件、尝试方向和未决问题；不替我作答，不将未选方案当成决定。推荐要说明理由与代价。正文优先满足阅读，用自然文句链接相关 DD，将功能字段和关系索引后置。对白、色板属于原 Markdown 文档；需要布局或注释时只读取对应公开伴随文件，.cewen 私人数据不自动分享。分类归属与手工关联分别核对来源。保留稳定身份、原始回答与历史；修改先形成可核对的提案，按我授权的范围保存并记录版本。'].filter(Boolean).join('\n\n');
}
