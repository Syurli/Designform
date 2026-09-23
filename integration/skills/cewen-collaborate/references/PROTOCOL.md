# 策问文件与交换约定

应用、文档格式、接口协议分别编号。当前文档格式与协议均为 1。问题与提案包都使用 UTF-8 JSON；软件内“资料交换”可以接收。

读取入口：`PROJECT.md` → `docs/gdd/` → 所需 `docs/dd/` 与 `docs/questions/`。涉及该文档的画布布局、对白节点摆放或项目共享注释时，再读取 `docs/layouts/<文档ID>.json`、`docs/annotations/<文档ID>.md` 和 `.ink.json`；缺少伴随文件表示尚未建立对应公开布局或注释，不影响 Markdown 正文。项目目录与工具安装目录分离。`.cewen/` 的个人布局、私人批注与未保存草稿不属于公开正文。

0.4 的设计分类在 `PROJECT.md` 头部 `systems` 中登记，每项为稳定 `id`、`title`、十六进制 `color`，数组顺序为展示顺序。DD 的 `system` 引用该身份。`systems` 存在时（包括空数组）即为权威来源；缺少该字段才读取旧 GDD 的同名字段。分类首次编辑会将当前登记迁到 PROJECT.md，设置 `minimumAppVersion: 0.4.0`，清除当前 GDD 中的重复登记；历史不修改。分类不生成空 DD；删除分类要明确成员去向并同批更新文档。

写作界面默认隐藏文件头，但公开文件仍保留必要身份。新稿与临时附件在正式保存前属于私人草稿；不得把 `.cewen/drafts` 当成已确认策划。保存时正文、附件和新增分类一起产生一个版本。

## 统一文档的设计块与伴随文件（0.6）

对白与色板写在原 GDD/DD 的 `cewen-dialogue`、`cewen-palette` fenced YAML 设计块中，图片与参考仍引用 `docs/assets/`；不另建图片、对白、色板或参考文档。对白正文预览可点选项，独立编辑页操作同一设计块。对话跳转只由 `to`、`next`、`then`、`else`、`target` 等显式字段决定，不从节点坐标或 YAML 顺序推断。色板的正式颜色与源图提取候选分开，不能臆造取色面积。

设计块与其中节点、选项、色标的 `id` 是稳定身份，文字、布局或颜色变化时保留。公开 `docs/layouts/<文档ID>.json` 只保存块/对白节点的位置、尺寸与层级，不复制台词或正文；`docs/annotations/<文档ID>.ink.json` 保存项目共享笔画、文本、箭头及锚点，`docs/annotations/<文档ID>.md` 保存共享讨论说明。私人注释默认不进入这些路径。完整字段参见项目或软件附带的 [设计块协议](../../../../docs/protocol/DESIGN_BLOCKS_0.6.md)与[公开伴随文件协议](../../../../docs/protocol/DOCUMENT_COMPANIONS_0.6.md)。桌面发行包内对应路径为 `resources/integration/protocol/DESIGN_BLOCKS_0.6.md` 与 `DOCUMENT_COMPANIONS_0.6.md`（相对于本文件是 `../../../protocol/`）；按实际安装形态定位，不猜字段。

公开伴随文件与正文同批提交并带文件哈希，版本恢复产生新修订。模型先确认当前修订及文件基准，只修改用户授权的范围；预演状态、候选配色和私人注释不自动写进正式规则。

## 问询包

```json
{
  "requestId": "round-request-001",
  "round": "ROUND-001",
  "questions": [{
    "id": "question-rest-001",
    "title": "休息需要消耗资源吗？",
    "background": "说明本项目已有依据和仍未确定的边界。",
    "options": ["A 方案：说明理由、收益与代价；推荐也必须注明依据。", "B 方案：说明理由、收益与代价。"],
    "targets": ["实际存在的条目ID"]
  }]
}
```

每个问题有稳定 ID，重复讨论引用原问题。用户自定义、暂缓、前提不成立由工作台统一提供，不必伪造选项。发布时基础修订写入问题头部，原始回答追加到独立章节。

## 修改提案

```json
{
  "id": "proposal-001",
  "title": "根据回答明确休息成本",
  "reason": "写明依据的回答及设计理由",
  "baseRevision": "从上下文包读取的稳定修订ID",
  "questionIds": ["实际问题ID"],
  "dependencies": {"docs/dd/DD-001.md": "读取时的SHA256"},
  "changes": [{"path": "docs/dd/DD-001.md", "baseHash": "读取时的SHA256", "text": "完整候选Markdown，保留原元数据和无关正文"}]
}
```

新文件的 `baseHash` 为 null；删除文件的 `text` 为 null。涉及的问题决定和落实记录也放入同一提案。用户可以分批采纳，但每批仍要保持引用完整。

接口出现 `FILE_CONFLICT`、`DEPENDENCY_CHANGED`、`QUESTION_CHANGED` 时重新读取并核对，不能用旧内容重试覆盖。出现 `FILES_CHANGING` 时等文件完成保存，再使用同一逻辑请求核对。出现 `RECOVERY_REQUIRED` 时在软件处理未完成事务。

## CLI 与 MCP

先启动策问本地服务。CLI 为 `node runtime/cli.js help`；MCP 为 `node runtime/mcp.js`，使用 stdio。安装包内对应文件在 `resources/runtime/`，可使用发行包顶层 `策问CLI.cmd` 和 `策问MCP.cmd` 调用内置运行时，不必另装 Node。开发环境直接运行 JS 时需要 Node.js 24。`CEWEN_URL` 可指定桌面菜单“在浏览器打开”所用的本机地址。

MCP 提供项目列表、搜索、上下文、历史读取、问询发布、导入预检、提案暂存；不提供采纳用户答案或批准自己提案的工具。没有 MCP 时使用当前项目 Markdown 和交换面板完成同样的协作。

应用 0.2.2 增加连接状态和 `cewen_identify({"modelName":"实际已知的模型名"})`；也可在 MCP 配置 env 设置 `CEWEN_LLM_NAME`。未知时不填或报告空字符串。心跳在完成 MCP 初始化后每 10 秒上报，35 秒未收到则断开，页面每 4 秒刷新；正常关闭主动断开。客户端和模型是不同字段，不能把客户端名称当成型号。文件及 CLI 协作不建立持续连接。连接身份只存在于服务内存，不进入项目 Markdown 和版本。

多文件直接编辑使用 `cewen_begin_batch` / `cewen_end_batch` 包围一轮；`cewen_checkpoint` 只给已经落盘的当前稿建立版本，不代替提案审批。提案 dependencies 必须包含所引用的问题文件哈希；问题候选不得改写原话。
