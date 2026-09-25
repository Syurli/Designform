# 策问独立接入说明 · 协议 1

已发布0.8基线使用文档格式1。0.9.0-rc.3候选兼容项目格式1/2，新增模块需要格式2；接口协议1。本文、Schema、项目说明及当前 Markdown 足以继续策划，无需应用源码或旧聊天。

> 0.9候选新增12工具（总数32）及模块资源/续轮Prompt，详见 [Quest与MCP](QUEST_0.9.md)。下文20工具清单为原有兼容入口，不包含新增项。当前候选尚未发布；以客户端实际 tools/list 和 cewen_capabilities 为准。

## 用户开始协作

在新建入口组合游戏设想，或从“与 LLM 协作”和连接状态区生成开场白。类型、玩法、平台和本轮目标可多选，并可各自补充自定义内容；开发资源与单次时长保留单选。旧私人草稿中的单选目标和平台在读取时转为多选。正文可自由改写，选项或接入状态晚返回时不会覆盖手改文本，只有用户主动重新生成才替换。复制后发送给所用模型；软件会带入真实项目、修订和可用接入位置。

桌面版的开场白同时读取 `/api/connections` 返回的 MCP 客户端心跳。存在有效心跳时引导模型先用当前对话已有的策问工具；无有效心跳或连接状态无法核实时给出接入说明。其他客户端的心跳不能证明当前对话可调用工具，过期或断开状态不算已连接。尚未创建项目时只核对工具连通，已有项目时再核对项目身份。复制开场白、读取文件与看到服务地址均不代表 MCP 已连接。没有本机文件能力的模型使用用户提供的 Markdown 或上下文包。

下方 CLI / MCP 参数供模型和技术人员配置客户端时查阅；普通用户无需手填 JSON。模型无法代为完成客户端设置时，应准确指出客户端要求的操作，不承诺任意 LLM 均可自动安装 MCP。

## 工作顺序

1. 用户创建独立项目，或在策问预检指定来源目录。
2. 读取 PROJECT.md、docs/README.md、相关 GDD/DD 和问题。历史按需读取。
3. 获取当前修订、文件 SHA256 和关系；不能凭标题相近合并文档。
4. 发布问询，等待用户作答，再读取原话并生成修改提案。
5. 用户在策问审核采纳，返回公开修订才算正式落实。

真实游戏接入须固定工具版本，在用户指定的独立目标目录进行。来源保持只读；发现工具缺陷则保存脱敏复现并回到开发工作流，不在接入途中修改工具。

## CLI 与 MCP

先启动桌面程序。发行包顶层 `策问CLI.cmd help` 显示命令，`策问MCP.cmd` 是 stdio 启动入口，均使用内置运行时。

Windows MCP 客户端配置示例（路径和端口需替换）：

```json
{"mcpServers":{"cewen":{"command":"cmd.exe","args":["/d","/s","/c","\"D:\\你的安装目录\\策问MCP.cmd\""],"env":{"CEWEN_URL":"http://127.0.0.1:实际端口"}}}}
```

端口使用桌面菜单“在浏览器打开”的地址。未指定 CEWEN_URL 时读取默认项目中心的 connection.json。开发者可使用 Node.js 24 执行 runtime/cli.js 或 runtime/mcp.js。服务仅接受回环地址。

CLI：list、read、history、context、questions、propose、import-plan、commit、checkpoint、begin-batch、end-batch。除 list 外传项目 ID；需要请求体的命令再传 UTF-8 JSON 文件路径或 `-` 标准输入，不把全文塞进命令行转义。

MCP 共 20 个工具，按用途分为：
- 身份与项目：`cewen_identify`、`cewen_projects`、`cewen_status`。
- 当前内容：`cewen_search`（25 份/页）、`cewen_context`、`cewen_read_document`、`cewen_asset`。
- 历史与恢复信息：`cewen_history`、`cewen_read_revision`、`cewen_baselines`、`cewen_backup_status`、`cewen_prepare_restore`、`cewen_prepare_undo`。
- 问询与提案：`cewen_publish_questions`、`cewen_propose`、`cewen_proposals`。
- 导入与外部编辑：`cewen_prepare_import`、`cewen_begin_batch`、`cewen_end_batch`、`cewen_checkpoint`。

`cewen_status` 和上下文会返回当前诊断、恢复标记、指纹与公开文件哈希；`cewen_context` 支持 documentIds、nodeIds、collectionIds 与 annotationIds，其中工作区批注仍只允许显式选择的项目级内容。`cewen_read_document` 用字符窗口读取单份当前文档，避免大项目必须一次全量返回。`cewen_asset` 只读取项目 `docs/assets/` 下明确指定的 PNG/JPEG/WebP/GIF，单张上限 5 MB，并以 MCP image content 返回实际图像。

`cewen_proposals` 只列项目级提案，可用于换会话后核对待审核、部分采纳或已采纳状态。`cewen_prepare_restore` 与 `cewen_prepare_undo` 只生成计划，不执行恢复或撤销。

MCP 不提供代填用户答案、采纳自己提案、任意正文提交、任意磁盘读取或直接应用恢复计划的工具。读取问题 Markdown 即读取答案。项目创建/打开、导出路径选择等宿主管理行为仍由用户界面负责。

## 连接与模型身份

策问右上角显示 MCP 通道的真实心跳状态。完成 MCP 初始化才显示在线，仅启动适配器进程不算连接。客户端名称和版本来自初始化信息；模型名可通过环境变量 `CEWEN_LLM_NAME` 提供，也可调用 `cewen_identify({"modelName":"明确已知的实际模型名称"})` 报告。身份不明确时保留空值；不要从应用名猜测模型。详情区区分“连接配置”和“客户端自报”，这些名称并非服务商认证信息。切换模型时更新报告，不能继续沿用过期型号。

适配器每 10 秒报告心跳，正常关闭主动断开；异常退出在 35 秒无心跳后判为断开，界面每 4 秒刷新。连接服务暂不可达时显示“状态暂不可用”，不伪造离线结论。在线仅表示 MCP 通道在线，不表示模型在生成或当前项目已被模型完整读取。

多连接会显示数量，优先展示最近访问当前项目的连接，详情列出全部。最近访问项目与活动时间由实际项目工具调用记录。断开的连接保留最多 15 分钟，服务重启清空临时连接表，活跃适配器随后重新报告。身份和心跳只在服务内存中存放，不写入 `docs/`、`versions/` 或私人批注。

直接读取文件或使用 CLI 不建立持续连接；仍可正常协作，界面不会因此显示 LLM 在线。以上接入仅访问本机回环服务，不要求用户把模型密钥写入策问。

## 文件协作与版本

用户授权直接写多个 Markdown 时，先 begin-batch（requestId），保存返回的 id；全部落盘后 end-batch（batch、reason）。未结束的批次可读并有提示，暂不发布中间版本；错误修正后重试同一批次。无 MCP 时可用 CLI。

单文件普通编辑可由监听同步。监听只能记录实际观察到的稳定状态，软件关闭期间被覆盖的中间文件不能伪造为历史。checkpoint 显式保存当前实际文件，不改正文，不代替提案审核。

每个逻辑请求一个 requestId，重试保持 ID 和内容一致；改变内容后使用新 ID。提案另有稳定 id。baseRevision 是 manifest 的 id，不是 V000001 显示编号。

## 问询和提案

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

格式 1 是首个正式格式，没有需要兼容的旧格式。应用拒绝未知格式，不在打开时猜测并重写。升级前创建完整备份；未来迁移在副本执行，校验当前稿和公开历史后再切换入口。当前没有静默原地迁移或自动更新。
