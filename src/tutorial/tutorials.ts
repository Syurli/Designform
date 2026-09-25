import type { TutorialDefinition } from './tutorial-manager';

export const designformTutorials: TutorialDefinition[] = [
  {
    id: 'first-launch', version: 1, title: '认识策问', steps: [
      { id: 'welcome', title: '欢迎使用策问', description: '用几分钟认识项目、知识空间、策划写作、版本与 LLM 协作。你可以随时跳过，也可以快进到最后一步。' },
      { id: 'project', target: 'project-switch', title: '当前项目', description: '这里显示当前独立项目。点击可以查看项目身份、说明与设置。', side: 'right' },
      { id: 'directory', target: 'project-directory', title: '文档目录', description: 'GDD、专项设计和层级结构都从这里进入。目录、正文与知识空间读取的是同一份公开策划。', side: 'right' },
      { id: 'search', target: 'search', title: '搜索与筛选', description: '搜索标题、规则和正文；系统筛选可以快速缩小大型项目的阅读范围。', side: 'right' },
      { id: 'views', target: 'main-nav', title: '三种阅读方式', description: '知识空间用于理解关系，策划案用于连续阅读，卡片库用于快速浏览；它们不会复制出第二份设计数据。', side: 'bottom' },
      { id: 'graph', target: 'graph-modes', title: '知识空间', description: '在星图、系统分层和设计脑图之间切换。选中条目后可继续聚焦关系和依据。', side: 'bottom' },
      { id: 'create', target: 'new-document', title: '新建设计', description: '新建 GDD、DD 或问题。正式保存会进入项目版本历史。', side: 'bottom' },
      { id: 'edit', target: 'edit-document', title: '编辑当前文档', description: '从当前选择进入写作。Markdown 是权威正文，图片、对白和色板仍属于同一文档。', side: 'bottom' },
      { id: 'organize', target: 'organize-project', title: '整理与批注', description: '使用分组、项目批注、标记和阅读视图整理工作，不必把私人工作状态写进正式策划。', side: 'bottom' },
      { id: 'history', target: 'project-history', title: '版本历史', description: '每轮正式修改都有可追溯快照。这里可以比较、建立基线、恢复或生成撤销计划。', side: 'bottom' },
      { id: 'inquiry', target: 'project-inquiry', title: '设计问询', description: '把尚未决定的问题独立记录。模型可以给出方案，但答案仍由你确认。', side: 'bottom' },
      { id: 'exchange', target: 'project-exchange', title: '导入与交换', description: '导入现有资料前先预检，导出当前稿、历史或完整备份时也从这里进入。', side: 'bottom' },
      { id: 'llm', target: 'llm-collaboration', title: '与 LLM 协作', description: '生成本轮协作上下文、问询和修改提案。提案不会自动批准，正式决定仍由你审核。', side: 'bottom' },
      { id: 'connection', target: 'llm-connection', title: '连接状态', description: '桌面版会显示真实 MCP 心跳和模型身份。在线只表示通道可用，不表示模型已经读取全部项目。', side: 'left' },
      { id: 'refresh', target: 'refresh-project', title: '同步外部修改', description: '外部编辑 Markdown 后可主动重新扫描。哈希、诊断与恢复机制会保护当前项目。', side: 'bottom' },
      { id: 'finish', title: '可以开始了', description: '教程不会限制你的工作流。以后可点击顶部“？”重新查看完整教程或专题教程。' },
    ],
  },
  {
    id: 'knowledge-space', version: 1, title: '知识空间', steps: [
      { id: 'modes', target: 'graph-modes', title: '三种布局', description: '星图看整体联系，系统分层看归属，设计脑图从总纲展开设计脉络。' },
      { id: 'canvas', target: 'graph-canvas', title: '画布操作', description: '在画布中选择、缩放和移动；关系聚焦用于追踪直接依据。三维位置本身不是正式设计关系。' },
      { id: 'tools', target: 'graph-tools', title: '视图工具', description: '快速回到全图、缩放、切换标签和关系运动。' },
      { id: 'sidebar', target: 'project-directory', title: '从目录定位', description: '大型项目优先通过目录、系统和搜索缩小范围，再进入图谱阅读。' },
    ],
  },
  {
    id: 'authoring', version: 1, title: '策划写作', steps: [
      { id: 'new', target: 'new-document', title: '创建文档', description: '根据当前分类创建 GDD、专项设计或问题。' },
      { id: 'edit', target: 'edit-document', title: '进入写作', description: '选择条目后编辑对应正式文档；保存前草稿与公开版本彼此分离。' },
      { id: 'history', target: 'project-history', title: '保存与追溯', description: '正式保存形成版本。发生冲突时先比较，不覆盖其他窗口或外部编辑。' },
    ],
  },
  {
    id: 'llm-workflow', version: 1, title: 'LLM 协作', steps: [
      { id: 'connection', target: 'llm-connection', title: '确认连接', description: '桌面 MCP 连接会显示实际在线状态；网页版仍可通过文件和交换包协作。' },
      { id: 'collab', target: 'llm-collaboration', title: '开始协作', description: '生成任务开场白和上下文。模型读取当前修订后再提出问询或修改。' },
      { id: 'inquiry', target: 'project-inquiry', title: '问询', description: '模型发布问题，你在策问中回答；推荐方案不会自动成为你的答案。' },
      { id: 'history', target: 'project-history', title: '核对落实', description: '提案采纳后核对正式修订。跨多个 DD 的修改应逐文件确认是否落实。' },
    ],
  },
];

/** 仅导航和解释，不替用户作答、保存或提交生产。练习请先创建独立虚构项目。 */
const navigate=(tab:string,type?:string)=>(signal:AbortSignal)=>{if(signal.aborted)return;if(document.querySelector('dialog[open]'))throw new Error('请先保存或关闭当前对话框，再继续教程');window.dispatchEvent(new CustomEvent('cewen:tutorial-navigation',{detail:{tab,type}}));};
const overview=(title:string,description:string)=>({id:'note-'+Array.from(title).reduce((h,c)=>(Math.imul(h,31)+c.charCodeAt(0))>>>0,7).toString(36),title,description,chapter:'起点'});
const at=(id:string,target:string,title:string,description:string,tab:string,type?:string)=>({id,target,title,description,chapter:tab,before:navigate(tab,type)});
designformTutorials.push(
 {id:'start-090',version:1,title:'从预设开始 · 不设能力围墙',steps:[overview('先选起步资料，不选能力限制','所有项目都能使用地图、角色、剧情与分镜。无项目时在项目库选择跨领域预设；练习使用独立虚构目录。'),at('presets','creative-tabs','预设与示例','“追加”只增加内容，不能删除现有模块；新建可选空框架或带示例。','presets'),overview('正式项目与练习副本','网页练习使用浏览器本机存储；正式资料需明确选择本机文件夹。清除浏览器数据前请导出。')]},
 {id:'compose-090',version:1,title:'自由组合与共享对象',steps:[overview('一个源对象，多处使用','建议先创建《雾港来信》独立练习副本。教程只导航，不自动编辑。'),at('catalog','creative-tabs','全部模块','模块目录对所有预设相同。角色或分镜也可以插入战斗 DD。','objects'),at('reference','creative-object','引用与独立复制','编辑源对象会影响所有实时引用；引用实例只增加局部说明；独立复制创建新身份。','objects','map'),overview('修改前看影响范围','在详情底部检查使用位置，再决定修改共享源还是当前覆盖层。')]},
 {id:'quest-090',version:1,title:'Quest 多轮问策',steps:[overview('目标驱动，而不是聊天堆叠','先发起一个明确目标，选择关联对象；无模型时也能手工发布问题或接收问题包。'),at('quest','quest-workspace','当前轮次','目标、范围、问题和提案落实分别显示。多轮示例保留真实演示版本。','quests','quest'),at('answer','question-filter','只回答这一轮需要回答的题','支持部分回答、自定义、暂缓和否定前提。提交会保留原话，不会自动批准提案。','quests','quest'),at('continue','quest-continue','继续给 LLM','复制可编辑的续轮请求，带任务身份和真实修订；有 MCP 心跳不等于客户端会自动生成。','quests','quest'),overview('采纳才是落实','在原提案审核页按文件采纳；一部分未采纳时，Quest 仍显示部分落实。')]},
 {id:'questions-090',version:1,title:'文档中的问题层',steps:[overview('同一问题，多个视图','策划案顶部提供正文、正文＋问题、仅问题。行内作答与 Quest 使用同一份问题文件。'),at('filter','question-filter','状态筛选','待回答、已回答、部分落实和已落实分别过滤。用户改答后应重新核对旧提案。','quests','quest'),overview('从段落或对象开始','对本页／选区发起 Quest，或从地图、镜头卡发起。原文不因显示问题层而复制。')]},
 {id:'map-090',version:1,title:'地图复用与覆盖层',steps:[at('base','creative-object','共享底图','地图源保存底图与基础点位。其用途不受预设限制。','objects','map'),at('use','creative-object','战斗、剧情、机位分别覆盖','使用实例引用地图源，自己的点、路线、区域不会污染另一处用法。进入“编辑源对象”后，可在画布上添加、拖动点位、路线和区域；保存前可以撤销。','objects','map-use'),overview('统一引用，稳定身份','重命名或移动文档不改变地图身份。源地图变更后检查关联剧情和镜头。')]},
 {id:'voice-090',version:1,title:'角色、声音与对白',steps:[at('character','creative-object','角色卡','人物动机、造型版本和声音档案同属共享资料，任何文档都能引用。','objects','character'),at('voice','creative-object','声音档案','试音与读音约定不等于每句的表演要求。示例是标记过的机器合成音，不是真人克隆。','objects','voice'),at('speech','creative-object','台词只存一份','文字、角色、表演与采用声音保持稳定身份，分镜与排演引用这条台词。','objects','speech')]},
 {id:'animatic-090',version:1,title:'二维有声分镜排演',steps:[at('shot','creative-object','镜头与连续画面','同一镜头可以有多张连续分镜，连续画面不等于候选方案。','objects','shot'),at('player','animatic-player','三种布局与冻结版本','审阅、观影、台词排演使用同一份内容。播放中的新回导素材不会突然替换画面。','sequences','sequence'),at('timeline','animatic-player','声音可以跨镜','播放、定位、循环、调速、字幕和静音；描述不会自动念成旁白。时长冲突会提示，不自动改声音。','sequences','sequence'),overview('暂停并提问','点击暂停并发起 Quest，记录镜头／画面身份和局部时间。HTML 排演包是自包含文件，不是 MP4 视频。')]},
 {id:'production-090',version:1,title:'生产任务与批量回导',steps:[at('batch','production-panel','先固定生产依据','预览提示词和参考依赖，再保存任务批次。缺图、配音和角色资料可以在同一项目生产。','production','production'),at('return','production-panel','按任务清单匹配','先导出生产包与回执模板。回导按 batch/job/candidate 身份匹配，不能按文件排序猜镜头。','production','production'),overview('回导后仍要采用','候选不覆盖正式素材。旧依据生成的素材会标出过期。ComfyUI 实际运行需要你本机批准的 API 工作流。')]},
 {id:'mixed-090',version:1,title:'综合示例的创作路线',steps:[overview('《雾港来信》','在独立副本中完成练习：从地图出口是否提前暴露的问题，关联战斗、剧情和分镜。'),at('map','creative-object','从共享地图开始','同一底图被战斗 DD、剧情节点与镜头引用，各自覆盖层互不覆盖。','objects','map-use'),at('quest','quest-workspace','检查演示多轮问题','分别查看待回答、三轮追问、部分采纳、完成四个示例。不要把预置回答当成你的决定。','quests','quest'),at('production','production-panel','生产受影响的素材','固定新批次，再按稳定任务身份回导并选用。','production','production'),at('watch','animatic-player','重放并继续追问','检查图像、对白、声音和节奏；修改后重新打开排演才能使用新版本。','sequences','sequence')]}
);


/** 操作练习单独记进度。只接收当前独立练习项目内的实际界面操作回执。 */
let practiceProject='';let activeProject='';const evidence=new Map<string,number>();
export function setTutorialProject(id:string){if(activeProject!==id)evidence.clear();activeProject=id;}
export function setPracticeProject(id:string){practiceProject=id;activeProject=id;evidence.clear();try{localStorage.setItem('cewen-tutorial-practice-project',id);}catch{}}
try{practiceProject=localStorage.getItem('cewen-tutorial-practice-project')??'';}catch{}
export function isPracticeProject(id:string){return id===practiceProject&&!!id;}
window.addEventListener('cewen:tutorial-evidence',event=>{const detail=(event as CustomEvent<{name:string;projectId?:string}>).detail;if(!detail?.name||activeProject!==practiceProject||detail.projectId&&detail.projectId!==activeProject)return;evidence.set(detail.name,(evidence.get(detail.name)??0)+1);});
function exercise(id:string,title:string,description:string,tab:string,type:string|undefined,eventName:string):import('./types').TutorialStep{
 let baseline=0;return {id,title,description,chapter:'操作练习',target:tab==='quests'?'quest-workspace':tab==='sequences'?'animatic-player':tab==='production'&&type?'production-panel':type?'creative-object':'creative-tabs',optional:true,before:signal=>{if(activeProject!==practiceProject||!practiceProject)throw new Error('请先通过教程中心创建独立虚构练习项目。');baseline=evidence.get(eventName)??0;if(!document.querySelector('dialog[open]'))navigate(tab,type)(signal);},check:()=>activeProject===practiceProject&&(evidence.get(eventName)??0)>baseline?true:'尚未收到本步操作的完成回执。请实际操作，或者选择“跳过本步”。'};
}
const exercises:[string,string,import('./types').TutorialStep[]][]=[
 ['start-090','预设与模块练习',[exercise('insert','插入一个模块','点击“插入模块”，选择任意模块，填写必填项并保存。只能在独立练习副本进行。','objects',undefined,'object-saved')]],
 ['compose-090','自由组合练习',[exercise('reference','引用共享地图','打开共享地图，点击“引用到文档”，选择现有普通文档并保存。不要选择独立复制。','objects','map','object-referenced'),exercise('copy','再创建独立副本','点击“独立复制”，修改名称后保存。新对象使用独立身份，不会覆盖共享源。','objects','map','object-copied')]],
 ['quest-090','多轮问策练习',[exercise('create','发起一个 Quest','从模块卡点击“对此发起 Quest”，填写真实练习目标并保存。','objects','map-use','quest-created'),exercise('answer','提交一条练习回答','在演示任务中填写自己的补充并提交；这是练习项目，不修改真实游戏。','quests','quest','questions-answered'),exercise('continue','准备下一轮请求','点击“准备下一轮给 LLM”，核对任务与修订并复制请求。无需伪造模型已连接。','quests','quest','quest-continuation')]],
 ['questions-090','问题筛选练习',[exercise('filter','切换问题筛选','切换状态、Quest或轮次筛选，观察同一份问题数据；不需要重新输入原始答案。','quests','quest','questions-filtered')]],
 ['map-090','地图覆盖层练习',[exercise('draw','编辑覆盖层','打开覆盖层的编辑器，在画布添加或拖动一个标记。此动作不改变共享底图。','objects','map-use','map-edited'),exercise('save','保存当前覆盖层','保持编辑器打开，核对修改后保存；不能只点击教程下一步代替保存。','objects','map-use','object-saved')]],
 ['voice-090','角色与声音练习',[exercise('listen','实际试听声音','点击试音播放器播放演示音频。示例是机器合成验证音，不是真人表演。','objects','voice','voice-played'),exercise('edit-line','修改练习台词','编辑一条对白的表演说明并保存。旧配音任务应保留其原始基准。','objects','speech','object-saved')]],
 ['animatic-090','排演节奏练习',[exercise('play','播放排演','打开演示序列并点击播放，观察声音和画面；任何时候都可暂停。','sequences','sequence','sequence-played'),exercise('timing','保存一次节奏调整','点击调整镜头时长，预览顺延影响后确认保存。也可按键录制整段节奏再保存。','sequences','sequence','timing-saved')]],
 ['production-090','生产与回导练习',[exercise('preview','预览生产任务','回到生产列表，点击准备生产任务，选择镜头或场次，预览提示词。此步骤不提交外部模型。','production',undefined,'production-previewed'),exercise('prepare','保存经过选择的任务','在预览中至少勾选一项，可改提示词，再保存批次。','production',undefined,'production-prepared'),exercise('export','导出通用生产包','打开生产批次并导出任务包和结果清单。生成软件可在策问之外执行。','production','production','production-exported'),exercise('return','登记候选','选择自己的输出目录与结果清单，或者手工映射文件；预检后登记所选候选。没有素材时可明确跳过。','production','production','candidates-imported'),exercise('adopt','明确采用候选','选中有效候选，核对目标后采用。回导成功本身不代表已采用。','production','production','candidate-adopted')]],
 ['mixed-090','综合流程练习',[exercise('map','调整地图使用实例','编辑战斗覆盖层并保存，不修改底图或镜头覆盖层。','objects','map-use','object-saved'),exercise('question','提出一个跨模块问题','围绕出口信息暴露时机发起 Quest，关联地图、剧情和镜头。','objects','map-use','quest-created'),exercise('watch','重放验证表达','播放本项目排演，观察刚才的问题应怎样影响镜头。','sequences','sequence','sequence-played')]],
];
for(const [base,title,steps] of exercises)designformTutorials.push({id:base+'-practice',version:1,title:'操作练习 · '+title,practice:true,steps});
