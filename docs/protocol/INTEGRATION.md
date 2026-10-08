# 策问独立接入说明 · 协议 1

本机连接先通过轻量 `/api/session?handshake=1` 获取凭证，独立于项目库刷新和历史读取。握手允许 20 秒，心跳允许 5 秒；服务重启后重新读取地址及凭证。错误明确区分握手超时、接口超时、HTTP 拒绝与网络断开，不统一解释为服务未启动。项目中心保留最近 100 条脱敏时序记录，位置为 `diagnostics/connection-timing.json`。修订验收见 [连接故障修订](MCP_CONNECTION_20261008.md)。

已发布0.8基线使用文档格式1。0.9.0-rc.3候选兼容项目格式1/2，新增模块需要格式2；接口协议1。本文、Schema、项目说明及当前 Markdown 足以继续策划，无需应用源码或旧聊天。

> 当前源码注册 38 个 MCP 工具：原20工具、创作扩展12工具和协作任务6工具。任务参数见[协作任务协议](COLLABORATION_WORK.md)，创作扩展见[Quest与MCP](QUEST_0.9.md)。以客户端实际 `tools/list` 与 `cewen_capabilities` 为准；真实设备／模型接入仍待人工验收。

## 用户开始协作

新建先选游戏、叙事、剧本、微电影、综合或空白。非空白提供领域多选、自定义及可跳过输入，资源与时长可自由补充；空白直接名称位置。旧私人草稿恢复为多选，捷径追加选择不清空已有内容。手改开场白不会被选项或连接状态晚响应覆盖。创建后提供“复制本项目开场白”，绑定真实快照身份；项目简介仅保存设想，不保存完整提示。详见[新建协议](PROJECT_CREATION_COLLABORATION.md)。

桌面版的开场白同时读取 `/api/connections` 返回的 MCP 客户端心跳。存在有效心跳时只提供简短工具检查，不重复 Skill、guide、launcher 或初始化材料；无有效心跳或无法核实时把初始化置于开场白最前。其他客户端的心跳不能证明当前对话可调用工具，过期或断开状态不算已连接。尚未创建项目时只核对工具连通，已有项目时再核对项目身份。复制开场白、读取文件与看到服务地址均不代表 MCP 已连接。没有本机文件能力的模型使用用户提供的 Markdown 或上下文包。

下方 CLI / MCP 参数供模型和技术人员配置客户端时查阅；普通用户无需手填 JSON。模型无法代为完成客户端设置时，应准确指出客户端要求的操作，不承诺任意 LLM 均可自动安装 MCP。

## 工作顺序

1. 用户创建独立项目，或在策问预检指定来源目录。
2. 读取 PROJECT.md、docs/README.md、相关 GDD/DD 和问题。历史按需读取。
3. 获取当前修订、文件 SHA256 和关系；不能凭标题相近合并文档。
4. 用户已经发起的普通创作或修改执行 `cewen_work_begin → cewen_work_documents → cewen_work_write → cewen_work_finish`，先保存暂定初稿，同时提出关键问题。目标、分类和文档数量按实际内容决定。
5. 以 finish 成功回执与公开修订确认本轮已保存。用户明确要求审核时才走提案。问询回答保留原话，先分析，再等待用户明确同意下一轮；保存初稿不等于用户确认。

自动备份、文档锁、实时投影和失败恢复见[协作任务协议](COLLABORATION_WORK.md)。Pages 与本机 MCP 独立运行，项目部署、启动、配对与断线边界见[Pages 接入](PAGES_CONNECTOR.md)。

真实游戏接入须固定工具版本，在用户指定的独立目标目录进行。来源保持只读；发现工具缺陷则保存脱敏复现并回到开发工作流，不在接入途中修改工具。

## CLI 与 MCP

### 本机 Codex 固定安装入口

本机日常策划协作通过 `C:/Users/qbz19/Desktop/01Work/Designform/App/Current` 接入，Current 是指向已核对安装目录的目录链接，不是源码副本。Codex 的 `cewen` 配置从该入口执行 `策问MCP.cmd`，工作目录也设为该入口；不固定 `CEWEN_URL`，使用默认策问工作区的 `connection.json` 查找正在运行的桌面服务。

协作 Skill 位于此入口下 `resources/integration/skills/cewen-collaborate/SKILL.md`，参考资料按它的相对链接读取；协议和 Schema 位于 `resources/integration/protocol/`，使用说明与构建身份位于顶层 `使用说明.md`、`LOCAL_BUILD.json`。这些都是随安装版发布的内容。用户游戏资料仍由 MCP 返回的独立项目身份与公开文件确定，不能把安装目录当作游戏项目。

更新本地安装或桌面快捷方式时，同步切换 Current，且核对二者指向同一个已安装版本。切换链接不会替换已经启动的 MCP 会话，需要客户端重新连接；现有聊天的工具列表也应在重连后核对。不按文件夹日期猜测“最新”，不从开发工程加载正常协作材料。

先启动桌面程序。发行包顶层 `策问CLI.cmd help` 显示命令，`策问MCP.cmd` 是 stdio 启动入口，均使用内置运行时。

Windows MCP 客户端配置示例（路径和端口需替换）：

```json
{"mcpServers":{"cewen":{"command":"cmd.exe","args":["/d","/s","/c","\"D:\\你的安装目录\\策问MCP.cmd\""],"env":{"CEWEN_URL":"http://127.0.0.1:实际端口"}}}}
```

端口使用桌面菜单“在浏览器打开”的地址。未指定 CEWEN_URL 时读取默认项目中心的 connection.json。开发者可使用 Node.js 24 执行 runtime/cli.js 或 runtime/mcp.js。服务仅接受回环地址。

CLI：list、read、history、context、questions、propose、import-plan、commit、checkpoint、begin-batch、end-batch。除 list 外传项目 ID；需要请求体的命令再传 UTF-8 JSON 文件路径或 `-` 标准输入，不把全文塞进命令行转义。

以下为原20个工具；新增六个任务工具见[完整任务契约](COLLABORATION_WORK.md)，创作扩展见[Quest工具](QUEST_0.9.md)。

原有工具按用途分为：
- 身份与项目：`cewen_identify`、`cewen_projects`、`cewen_status`。
- 当前内容：`cewen_search`（25 份/页）、`cewen_context`、`cewen_read_document`、`cewen_asset`。
- 历史与恢复信息：`cewen_history`、`cewen_read_revision`、`cewen_baselines`、`cewen_backup_status`、`cewen_prepare_restore`、`cewen_prepare_undo`。
- 问询与提案：`cewen_publish_questions`、`cewen_propose`、`cewen_proposals`。
- 导入与外部编辑：`cewen_prepare_import`、`cewen_begin_batch`、`cewen_end_batch`、`cewen_checkpoint`。

`cewen_status` 和上下文会返回当前诊断、恢复标记、指纹与公开文件哈希；`cewen_context` 支持 documentIds、nodeIds、collectionIds 与 annotationIds，其中工作区批注仍只允许显式选择的项目级内容。`cewen_read_document` 用字符窗口读取单份当前文档，避免大项目必须一次全量返回。`cewen_asset` 只读取项目 `docs/assets/` 下明确指定的 PNG/JPEG/WebP/GIF，单张上限 5 MB，并以 MCP image content 返回实际图像。

`cewen_proposals` 只列项目级提案，可用于换会话后核对待审核、部分采纳或已采纳状态。`cewen_prepare_restore` 与 `cewen_prepare_undo` 只生成计划，不执行恢复或撤销。

MCP 不提供代填用户答案、采纳自己提案、任意磁盘读取或直接应用恢复计划。正文修改由 `cewen_work_*` 在已登记目标内执行，自动保存不授权改写用户原话、决定或历史。读取问题 Markdown 即读取答案。项目创建/打开、导出路径选择等宿主管理行为仍由用户界面负责。

## 连接与模型身份

策问右上角显示 MCP 通道的真实心跳状态。完成 MCP 初始化才显示在线，仅启动适配器进程不算连接。客户端名称和版本来自初始化信息；模型名可通过环境变量 `CEWEN_LLM_NAME` 提供，也可调用 `cewen_identify({"modelName":"明确已知的实际模型名称"})` 报告。身份不明确时保留空值；不要从应用名猜测模型。详情区区分“连接配置”和“客户端自报”，这些名称并非服务商认证信息。切换模型时更新报告，不能继续沿用过期型号。

适配器每 10 秒报告心跳，正常关闭主动断开；异常退出在 35 秒无心跳后判为断开，界面每 4 秒刷新。连接服务暂不可达时显示“状态暂不可用”，不伪造离线结论。在线仅表示 MCP 通道在线，不表示模型在生成或当前项目已被模型完整读取。任务状态另行计算：灰色未连接、绿空心空闲、黄闪编写、绿实心完成、红色异常；异常优先且显示并发数，细节见[实时协作界面](COLLABORATION_UI.md)。

多连接会显示数量，优先展示最近访问当前项目的连接，详情列出全部。最近访问项目与活动时间由实际项目工具调用记录。断开的连接保留最多 15 分钟，服务重启清空临时连接表，活跃适配器随后重新报告。身份和心跳只在服务内存中存放，不写入 `docs/`、`versions/` 或私人批注。

直接读取文件或使用 CLI 不建立持续连接；仍可正常协作，界面不会因此显示 LLM 在线。以上接入仅访问本机回环服务，不要求用户把模型密钥写入策问。

## 受控任务、文件协作与版本

普通 MCP 创作优先使用[任务工具](COLLABORATION_WORK.md)，由服务端分离原稿和工作稿，完成时形成正式版本。下方外部批次用于已经授权的宿主文件编辑，不替代默认任务保存。

用户授权直接写多个 Markdown 时，先 begin-batch（requestId），保存返回的 id；全部落盘后 end-batch（batch、reason）。未结束的批次可读并有提示，暂不发布中间版本；错误修正后重试同一批次。无 MCP 时可用 CLI。

单文件普通编辑可由监听同步。监听只能记录实际观察到的稳定状态，软件关闭期间被覆盖的中间文件不能伪造为历史。checkpoint 显式保存当前实际文件，不改正文，不代替提案审核。

每个逻辑请求一个 requestId，重试保持 ID 和内容一致；改变内容后使用新 ID。提案另有稳定 id。baseRevision 是 manifest 的 id，不是 V000001 显示编号。

## 问询与可选提案审核

提案是用户明确要求审核时的可选流程，不是普通初稿的默认保存门槛。已有回答分析按专用规则执行，不能绕过用户续轮确认。

问询结构见 questions.schema.json。推荐方案写明理由、收益与代价；软件提供自定义/暂缓/前提错误。mode 为 single 或 multiple；follows 标明前题，when 可要求前题回答或选中指定选项原文。前题不满足时题目可读、暂不可答。

提案结构见 proposal.schema.json。changes 保存完整候选文本，保留无关段落；新文件 baseHash 为 null，删除 text 为 null。dependencies 包含所有设计依据的哈希，至少包含 questionIds 对应的问题文件。问题候选完整保留“用户原始回答”，分别补充“模型解释”和“决定记录”。

采纳时自动维护逐文件落实记录，部分采纳不代表全部落实。用户可在审核区修改候选；原提案和实际采纳版本分别保留。改答会使旧提案失效。

上下文默认只含公开文档。用户可按 DD、条目或分组选择，条目带所在完整 DD；边界关系可能指向包外文档，可另行读取。项目批注仅在显式选择后附上。超过 4 MB 要求缩小范围，不静默截断。

## 导入、导出、恢复

目录接入接受 Markdown，或命名为 cewen-import.json/context.json 的交换包：documents 数组每项包含 path、text。预检固定候选、身份/路径映射、来源原文和指纹；已有 ID 按身份更新，无 ID 按来源路径生成稳定身份。换来源路径时保留生成的 ID。

预检不写当前稿；可跳过、编辑身份/归属/关系后再次预检。确认只应用最近预检的固定候选。重复内容不造空版，附件和相对链接一起迁移。

导出以最后写入 PACKAGE.json 为完成凭据。当前稿、历史、完整包逐步扩大范围；完整包可携带个人记录。首次打开校验清单并恢复工作记录。原项目恢复到新路径时先移除旧最近入口；复制新项目则生成新项目 ID 和初始版本，不混入旧身份的历史。

## 错误码

| 代码 | 处理 |
|---|---|
| FILE_CONFLICT / DEPENDENCY_CHANGED | 重新读取并比较，不能清空基准强行覆盖 |
| QUESTION_CHANGED / ORIGINAL_ANSWER_CHANGED | 重新读取原始回答并重做提案 |
| IDEMPOTENCY_MISMATCH | 核对同 ID 的上次结果，新内容另建 ID |
| FILES_CHANGING / EXTERNAL_BATCH_OPEN | 等保存完成或结束已打开批次 |
| DOCUMENT_INVALID / IMPORT_INVALID | 修复报告中的身份、关系或格式再预检 |
| RECOVERY_REQUIRED / RECOVERY_CONFLICT | 在版本界面处理；第三方新稿不被覆盖 |
| HISTORY_DAMAGED / PACKAGE_DAMAGED | 保留现场，从有效备份恢复 |
| WORKSPACE_CONFLICT | 重开面板合并记录 |
| UNDO_CONFLICT | 旧批次和后续内容重叠，手工合并 |
| CONTEXT_TOO_LARGE / PACKAGE_TOO_LARGE | 缩小范围；没有静默截断 |
| SESSION_REQUIRED / OFFLINE | 重连已启动的本地服务，保留草稿 |

## 升级边界

当前读取项目格式 1 / 2。新工程采用格式 2；格式 1 启用需要升级的能力时在指定副本迁移。应用拒绝未知格式，不在打开时猜测并重写。升级前创建完整备份；未来迁移在副本执行，校验当前稿和公开历史后再切换入口。当前没有静默原地迁移或自动更新。

## 本地 0.9.2 V2.2：回答分析与续轮

本地文档栏规则见 [PROJECT_DIRECTORY_0.9.2.md](PROJECT_DIRECTORY_0.9.2.md)。`PROJECT.md` 可携带 `documentListOrder` 身份数组，仅用于目录及卡片库展示顺序；不要据此改写分类、父文档或正文。收藏分类和两类图钉是本机个人偏好，不属于公开设计结构。

逐题“下一题”只写私人草稿，汇总提交才追加到公开问题 Markdown。本轮分析开场白绑定 projectId、文档范围、提交 requestId、成功 revision、questionId／answerId 与问题 hash。先读取和分析原始回答，再询问用户是否开始下一轮，并等待明确回复。提交回答、复制开场白和采纳提案都不是续轮同意。

- `cewen_context`／`cewen_read_document`：读取明确范围；私人作答缓存不对外提供。
- `cewen_propose`：保存待审核修改；原始回答保留，用户决定采纳。
- `cewen_publish_questions`／`cewen_quest_round`：用户同意本轮后发题。后者同时追加摘要和新题，不能仅用于保存分析。
- `continue-quest` 与随附协作 Skill 使用同一流程。MCP 不自动发送开场白或唤醒模型，连接心跳不是消息回执。当前没有跨客户端核验聊天同意的服务端强制许可。

文档块沿用稳定身份注释，并可带公开父级：`<!-- cewen:block ID parent=父标题ID -->`；`parent=root` 表示文档直属。旧标记继续按标题推断。Markdown 源顺序负责阅读顺序，公开 layout 负责坐标；显式排序保留归属。移动内容时保留这些标记，不能仅凭画布坐标猜顺序。
