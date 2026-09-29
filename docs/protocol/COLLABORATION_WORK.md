# 本轮创作任务与自动保存 · 协议 1

本文描述当前源码的 MCP 与 HTTP 契约。普通用户已经发起的创作或明确修改默认自动保存，明确要求审核时才使用提案。保存初稿、工作锁和版本均不表示用户确认模型假设，也不授权代答或连续自动开下一轮。

关联文档：[新建项目](PROJECT_CREATION_COLLABORATION.md)、[MCP 接入](INTEGRATION.md)、[实时界面](COLLABORATION_UI.md)、[Pages 独立本机环境](PAGES_CONNECTOR.md)、[项目问询](PROJECT_QUESTIONS_0.9.2.md)、[协作 Skill](../../integration/skills/cewen-collaborate/SKILL.md)。

## 默认工作顺序

核对当前项目、修订与诊断后，执行 `cewen_work_begin → cewen_work_documents → cewen_work_write → cewen_work_finish`。按实际内容登记目标，不预建固定空文档或要求用户先确定文档总数。已知信息足以创作时先出暂定初稿，同时整理少量关键问题；未知部分明确标为假设。

原稿在目标登记时备份，正在编写的文档及其公开伴随文件由服务端锁定。写入持久保存工作稿并通知工作台；finish 校验原稿、依赖与格式后提交公开 Markdown 和一个版本。工作稿展示与正式版本分离，只有成功 finish 才报告本轮正式保存完成。

## MCP 参数

以下对象键为实际工具参数。`?` 表示可选；`projectId` 为真实项目身份，不是目录、标题或显示版本号。适配器在每次调用前等待当前 MCP 心跳登记，POST 自动补入自身 `connectionId`；模型不能自行指定其他连接。

共同限制：身份匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$`；`requestId` 为1～180字符；`generation` 为正整数；哈希为64位小写十六进制 SHA-256。每个新操作使用新 requestId，同内容重试保留原 requestId。恢复后的新代次不得沿用旧代次写入。

| 工具 | 参数 | 回执与用途 |
| --- | --- | --- |
| `cewen_work_begin` | `projectId, requestId, title, documentIds?` | title 为1～500字符；documentIds 默认空，最多200。返回 taskId、generation、status、documentIds；首次成功另有项目身份、修订、分类及目标摘要。 |
| `cewen_work_documents` | `projectId, taskId, generation, requestId, documents, groups?` | 登记已有目标或新文档，返回每份 documentId、title、path、sequence、isNew、hash。 |
| `cewen_work_write` | `projectId, taskId, generation, requestId, documentId, mode, text, oldText?, expectedSequence` | mode 为 replace / append / replace-text；expectedSequence 为非负整数，返回新 sequence、hash、taskId、generation。 |
| `cewen_work_finish` | `projectId, taskId, generation, dependencies?` | dependencies 为公开文件路径到 SHA-256 的映射；返回状态与成功修订。服务端使用任务与代次形成固定完成请求，完成重试不重复造版本。 |
| `cewen_work_status` | `projectId, taskId?, includeDrafts?` | includeDrafts 默认 false，返回状态摘要；读取恢复稿必须指定 taskId 且显式传 true。 |
| `cewen_work_control` | `projectId, taskId, requestId, action` | action 仅 cancel / resume。取消保留原稿和工作稿，恢复返回新的 generation；同一次控制重试复用 requestId。 |

`documents` 为最多200项数组，每项为 `{documentId?, title?, type?, system?, parent?}`。已有文档指定 documentId；新文档必须有1～200字符 title，type 可选 gdd / dd / guide / question，默认 dd。软件分配新身份与路径，system 和 parent 是稳定分类／父文档身份。单轮累计最多200份文档。

`groups` 为最多60项数组，每项为 `{id, label, color, parent?}`，label 为1～200字符中文名称，color 是六位十六进制颜色（如 `#7CBFFF`）。只登记实际需要的分类；相同分类身份的不同内容会报冲突，不覆盖其他任务。

写入模式：replace 替换完整正文；未提供 YAML 头时保留登记时头部并补标题。append 在当前工作稿末尾追加，调用方负责换行。replace-text 要求 oldText 存在且唯一，否则拒绝猜测。text / oldText 工具上限为4 Mi字符，服务端另外校验输入与最终工作稿 UTF-8 不超过4 MiB。模型不得通过替换修改文档身份、类型、用户原始回答或决定记录。

## HTTP 与事件契约

全部接口复用本机 API 会话鉴权 `X-Cewen-Session`。HTTP 项目路径为 `/api/projects/:id/`；请求体不再需要 projectId。

| 方法与后缀 | 请求 |
| --- | --- |
| POST `work-begin` | `{connectionId, requestId, title, documentIds?}` |
| POST `work-documents` | `{connectionId, taskId, generation, requestId, documents, groups?}` |
| POST `work-write` | `{connectionId, taskId, generation, requestId, documentId, mode, text, oldText?, expectedSequence}` |
| POST `work-finish` | `{connectionId, taskId, generation, dependencies?}` |
| GET `work-status` | 查询 `taskId?` 与 `includeDrafts=1?`；默认无正文。指定任务时返回任务摘要与目标摘要，显式读取时目标包含工作稿 text。 |
| POST `work-control` | MCP 携带 `{connectionId, taskId, requestId, action}`；工作台用户控制可省略 connectionId，另支持 dismiss / undo。 |
| GET `work-events` | 查询 `cursor?`，返回鉴权 SSE。 |

SSE 的 `id` 是递增游标，data 为 `{cursor, projectId, kind, taskId?}`，kind 为 work / project / reset，不携带正文。首次订阅、过期游标或服务重启发送 reset，工作台重新读取快照和工作投影；断线重连保留游标。当前保留最多256条事件，15秒注释心跳，工作台另有6秒轮询兜底。切换项目释放旧订阅。

MCP 默认状态不读大量正文；普通公开上下文不包含中断任务恢复稿。工作台快照为了显示正在编写的内容可显式叠加运行任务投影，正式文件哈希仍作为独立保存基准。

## 备份、锁、并发与个人草稿

登记已有目标时，在项目私有 `.cewen/collaboration/<taskId>/before/` 保存对应 Markdown 与已存在的公开布局、注释原稿。工作任务记录持久保存在 `.cewen/collaboration/tasks.json`；这些路径是软件私有实现，不应作为模型上下文。新增文档的身份及路径由服务端分配，不开放任意磁盘写入。

长文档租约只保护目标，项目事务短时串行。不同目标可并发工作，同一目标拒绝第二个任务；人工提交、属性修改或伴随文件写入不能绕过服务端工作锁。个人阅读锁与工作锁相互独立，切换阅读锁不能解除模型租约。

工作台收到目标占用后结束当前输入并保留个人恢复稿；模型工作稿不覆盖用户个人稿或原保存基准。任务完成后可比较正式结果、原稿与个人稿再继续编辑。个人草稿与任务稿的 UI 边界见[实时协作界面](COLLABORATION_UI.md)。

## 中断、恢复与撤销

任务状态为 running / completed / interrupted / failed / cancelled。心跳仅证明连接存在，不证明任务有进展。租约检测到连接断开或宿主失效，或十分钟无任务进展时标记中断，保留所有恢复资料并推进 generation；旧请求不能继续写入。

cancel 停止自己的任务并保留原稿与工作稿。resume 仅在用户明确要求后执行，重新核对正式文件和伴随依赖、文档占用及有效连接；成功后新代次取代旧权限。原稿已被外部修改时拒绝恢复，先比较差异再另开任务，不强行覆盖。

finish 失败保留候选与错误，先读 status 核对实际状态与新代次。若正式提交成功但进程在回执前中断，服务端用可信版本中的固定请求身份恢复完成状态，避免重试重复发布。完成且存在有效 revision 的任务可由用户在工作台撤销，恢复形成新版本；后续修改重叠时仍需处理冲突。dismiss 仅清除停止任务的提示，不删除原稿。

| 错误 | 处理 |
| --- | --- |
| WORK_CONNECTION_REQUIRED | 核对本机服务、MCP 初始化及真实心跳登记。 |
| WORK_STALE_OWNER | 任务已停止、代次或连接变化；读取状态，不沿用旧权限。 |
| WORK_SEQUENCE_CONFLICT | 读取目标新序号／工作稿，比较后继续，不盲目重试旧序号。 |
| DOCUMENT_LOCKED | 目标被其他任务占用，可处理其他文档或由用户停止任务。 |
| WORK_BASE_CONFLICT / FILE_CONFLICT / DEPENDENCY_CHANGED | 原稿或依据变化，保留工作稿并比较。 |
| WORK_REPLACEMENT_AMBIGUOUS | oldText 不存在或不唯一，明确范围后重新替换。 |
| USER_ANSWER_PROTECTED / WORK_IDENTITY_CHANGED | 保留用户原话和文档身份，不能通过正文写入规避保护。 |
| IDEMPOTENCY_MISMATCH | 相同请求身份对应不同内容；核对上次结果，新内容另建请求。 |
| WORK_INCOMPLETE | 不发布仍未编写的新文档占位，补完正文再 finish。 |

## 状态灯与提案边界

灰色表示未连接；绿空心表示已连接空闲；黄闪表示任务正在编写；绿实心表示本轮完成；红色表示中断、失败或取消异常。异常优先显示，同时保留正在运行的并发数。状态来自任务记录与连接心跳，不从网页联网或复制动作推断模型正在生成；模型名称未知时不猜测。

用户明确要求审阅候选时，使用既有 propose / proposals 和用户采纳流程。普通任务自动保存不是自我批准提案。收到问询回答后仍先分析用户原话并等待用户明确同意下一轮；发题工具和自由正文写入都不能绕过此边界。

## 当前验证边界

主代理已使用虚构项目进行本机 HTTP 验收：登记／写入幂等、SSE首次reset、正式保存与完成重试、不同文档并发、同文档锁和人工commit拒绝、原稿备份、个人draft保存、cancel保留与旧代次拒绝、resume和外部冲突均通过。该记录是协议路径验证，不是真实设备、浏览器视觉或外部模型验收。

TypeScript 检查与差异检查已通过；未运行自动化测试套件，未提交或发布本轮修改。后续已完成 Windows 启动配对、来源隔离、真实五分钟过期和双 stdio MCP 客户端共用宿主；Chrome/Edge 目录授权、缓存、本地网络权限与媒体页面仍需人工验收，详见[Pages 接入边界](PAGES_CONNECTOR.md)。
