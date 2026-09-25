# 0.9 Quest 与增量协作

适用候选 `0.9.0-rc.3`。Quest 是创作目标和轮次的组织方式，不替代原有问题文档和审核服务。

## 主流程

选中文档、模块或排演位置发起 Quest → 明确目标与范围 → 发布一轮问题 → 用户填写部分或全部答案 → 复制/调用续轮请求 → LLM 读取真实答案后追加轮次 → 提交普通修改提案 → 用户在原审核区部分或全部采纳。

Quest、文档内问题层与独立问题列表共享同一个问题来源。问题层可切换正文、正文加问题或仅问题；问题列表可以按状态、Quest 和轮次筛选。原始回答通过 `ProjectService.answer` 追加，不直接改写旧答案。局部选区目前保留摘录和文件基准；复杂编辑后的稳定段落锚点重定位仍待完善。

## 不同状态

Quest 的 open/paused/closed 是任务状态。`answerState` 表示回答情况，`implementationState` 与逐提案 `appliedFiles` 表示落实情况。回答完成不自动成为设计决定，候选生成不自动成为采纳。已采纳结果或来源答案后来变化时应显示需要复核，而不能单凭旧 accepted 字段宣称有效。

轮次通过专用方法追加，包含稳定 roundId、questionIds、摘要、来源修订。通用模块表单不能任意重写已有轮次。示例中预置的提问、答案与采纳全部标注“演示”，不冒充用户真实决定或在线模型。

## MCP 新入口

现有 20 工具保留，新增 12 个：

- `cewen_capabilities`、`cewen_objects`、`cewen_object_read`、`cewen_object_context`。
- `cewen_quests`、`cewen_quest_create`、`cewen_quest_read`、`cewen_quest_events`、`cewen_quest_round`。
- `cewen_production_preview`、`cewen_production_read`、`cewen_media`。

另有 schema resource `cewen://schemas/modules` 与 `continue-quest` prompt。MCP 资源版本、项目格式、模块 schema、应用版本分开管理。

先读取 `cewen_capabilities` 和状态，再读取明确任务；已有上下文可用 `cewen_quest_events` 从真实修订游标接续。每次扫描最多 25 个版本，返回下一个游标、hasMore、相关变更和最新 Quest 状态。无效游标返回 CURSOR_EXPIRED，必须重读，不能假装没有新变化。当前返回仍携带最新 Quest，并非极致最小 delta。

`cewen_quest_round` 使用 requestId、Quest baseHash、依赖哈希和稳定问题 ID；同一逻辑请求重试保持全部内容一致，新内容换 ID。通常每轮 3～5 个关键问题，单次最多 30 个。

工具没有用户代答、自我批准提案、任意 commit、直接采用素材或未经确认执行生图功能。只提供生产预览/状态，外部产线提交仍需用户明确审核。宿主有额外终端或文件权限不属于 MCP 本身的权限沙箱。

## 接续边界

复制请求、工具心跳、schema 可见都不表示模型已开始生成。当前提供明确可复制的续轮请求；不能保证任意聊天客户端自动唤醒。独立网页版没有持续 stdio MCP 服务，仍通过文件包协作；桌面服务使用原有本机连接入口。
