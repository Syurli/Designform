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
