# 策问 Designform

**面向游戏开发的本地策划、知识组织与 LLM 协作工作台。**

策问是 BAIGE（百舸）体系下的游戏策划工具，将游戏总纲（GDD）、专项设计（DD）、问询、设计关系与版本历史组织在同一个工作空间中。项目以可直接阅读的 Markdown 为权威源；LLM 可以参与阅读、问询与修改建议，由用户保留设计决策和提案采纳权。

**当前源码版本：0.7.1 · 公开文档格式：1 · 接口协议：1**

[打开网页版](https://syurli.github.io/Designform/) · [下载 Windows 版](https://github.com/Syurli/Designform/releases/latest) · [LLM 接入说明](docs/protocol/INTEGRATION.md) · [开发与发布](docs/双版本开发与发布.md)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 策划编写 | 编写 GDD、DD 与问题文档，支持 Markdown 编辑、章节组织、引用、图片和草稿恢复。 |
| 知识组织 | 通过层级目录、三维星图、系统分层和设计脑图阅读同一份设计；分类归属、正文引用与手工关系各有明确来源。 |
| 统一设计文档 | 在同一份正文中组织对白、图片参考与色板；公开排版和共享注释使用伴随文件，不另建一套正文。 |
| LLM 协作 | 提供可预览、可编辑的任务开场白，以及 Skill、CLI 和 MCP 接入；支持问询、原始回答追溯、修改提案与部分采纳。 |
| 版本追溯 | 保存完整公开快照，支持版本比较、历史阅读、恢复、撤销计划和命名基线；恢复操作形成新修订。 |
| 资料交换 | 导入前预检身份、路径和差异，支持当前稿、历史包及完整备份导出，并提供本机自动恢复点。 |

## 开始使用

### 选择发行形态

| | 独立网页版 | Windows 桌面版 |
| --- | --- | --- |
| 入口 | [GitHub Pages](https://syurli.github.io/Designform/) | [GitHub Releases](https://github.com/Syurli/Designform/releases/latest) |
| 运行方式 | 使用支持文件夹授权的桌面 Chrome / Edge，通过 HTTPS 或 localhost 打开。 | 解压 Windows x64 便携包，运行 `策问 Designform.exe`。 |
| 项目存储 | 用户明确授权的本机文件夹。 | 用户指定的本机目录。 |
| LLM 接入 | 文件协作与交换包；不提供独立的持续 MCP 服务。 | 文件协作、CLI 与本地 stdio MCP。 |
| 安装要求 | 无需安装桌面程序。 | 内置运行时，无需另装 Node.js 或 npm。 |

两种形态共用业务规则与项目格式。同一项目应只保留一个策问写入端：先在当前端保存并关闭项目，再从另一端打开同一个目录。

### 建立第一个项目

1. 在项目中心选择空白项目、基础 GDD，或完全虚构的“纸上远行”示例。
2. 指定项目保存目录，编写总纲和专项设计，按需要建立分类、引用与问询。
3. 通过“与 LLM 协作”生成本轮开场白；完成修改后核对正式文档和版本记录。

网页版的虚构示例与自动恢复点保存在浏览器专用本机存储中，清除网站数据会影响这些内容；需长期保留时请导出到本机文件夹。正式项目必须选择磁盘目录。文件权限、两端接续与恢复边界见[双版本使用说明](docs/双版本开发与发布.md)。

桌面菜单“应用 → 在浏览器打开”会打开桌面程序提供的同一个本地工作台，而不是独立网页版；使用期间需保持桌面程序运行。

## 项目文件与数据边界

以下是策划项目的目录，不是软件源码目录：

```text
项目目录/
├── PROJECT.md          项目身份、说明与公开分类
├── docs/
│   ├── README.md       项目文档阅读说明
│   ├── gdd/            游戏总纲
│   ├── dd/             专项设计
│   ├── questions/      问题、用户原始回答与决定记录
│   ├── assets/         图片及其他相对路径附件
│   ├── layouts/        以文档 ID 命名的公开排版 JSON
│   └── annotations/    项目共享注释 Markdown 与笔画 JSON
├── versions/           完整公开快照、版本清单与基线
└── .cewen/             编辑器工作记录、草稿、提案、私人视图与索引等
```

`PROJECT.md` 与 `docs/` 是当前公开内容，`versions/` 用于追溯。公开布局和笔画是对应文档的伴随数据，不替代 Markdown 正文。`.cewen/` 包含不同共享范围的工作记录，不应整目录作为模型上下文；私人内容须经用户明确选择或发布。

应用的本地文件读写不会向 GitHub Pages 上传策划内容。用户主动把文档交给外部 LLM 时，数据处理范围取决于所用客户端、模型服务与授权设置，不能把“本地存储”理解为外部模型不会接收上下文。

## LLM 协作与 MCP

### 推荐工作流程

**读取相关文档与修订 → 澄清问题 → 用户作答 → 提交修改提案 → 用户审核采纳 → 核对新版本。**

接入桌面版时，先启动策问，再使用连接区生成的开场白。发行包顶层的 `策问MCP.cmd` 是 stdio MCP 启动入口；`策问CLI.cmd help` 可查看 CLI 命令。客户端配置、服务发现及环境变量见[独立接入说明](docs/protocol/INTEGRATION.md)。

当前 MCP 注册 **20 个工具**。除项目列表、搜索、上下文、历史、问询、提案、导入预检与外部批次外，还提供当前协作状态、单文档分页读取、项目级提案状态、图片附件读取、命名基线、备份状态，以及恢复/撤销的只读计划。MCP 是受审核的策划协作接口，目标是覆盖 LLM 实际需要的策划业务，而不是复制所有界面按钮。

公开 Markdown、对白与色板设计块，以及受控的公开排版和笔画 JSON，可以通过通用文本提案提交候选，再由用户审核。当前上下文会携带项目入口哈希、文件哈希、诊断与恢复状态，并支持按文档、条目、分组和显式项目批注选择；图片附件可由 `cewen_asset` 在项目边界内直接读取。完整覆盖与保留边界见 [MCP 能力审计](docs/protocol/MCP_CAPABILITY_AUDIT.md)。

MCP 不提供代填用户答案、自动采纳自己提案或任意正式文件提交的工具。`begin-batch`、`end-batch` 与 `checkpoint` 管理已获授权的外部文件编辑流程，本身不提供文件写入能力。CLI 或宿主文件工具的能力不能视为 MCP 已开放的能力。

连接区的在线状态只表示 MCP 通道存在有效心跳，不表示模型已读取全部项目或完成任务。模型名由配置或 `cewen_identify` 明确报告；未知时不猜测。

无法连接本机 MCP 的模型，仍可使用用户提供的 Markdown、上下文包及[协作 Skill](integration/skills/cewen-collaborate/SKILL.md)。策问不绑定模型厂商，也不自动调用模型生成内容。

## 源码开发

### 环境与启动

使用 **Node.js 24** 与 npm，依赖版本由 `package-lock.json` 固定。以下命令在仓库根目录执行：

```bash
npm ci
npm run dev
```

`npm run dev` 启动带本地文件服务的开发工作台。开发独立网页版时，改用 `npm run dev:web`，默认入口为 `http://127.0.0.1:5174/Designform/`。

| 命令 | 用途 |
| --- | --- |
| `npm run build:all` | 类型检查、桌面前端与独立网页构建、桌面服务和 CLI/MCP 运行时构建。 |
| `npm run serve` | 运行已构建的本地服务，需先生成 `dist/` 与 `runtime/`。 |
| `npm run desktop` | 启动 Electron 应用，需先完成前端和运行时构建。 |
| `npm run package:win` | 构建并打包 Windows x64 发行包。 |
| `npm run licenses` | 更新随应用分发的第三方许可材料。 |

桌面开发服务默认使用用户文档目录下的 `策问工作区/开发沙盒`，正式服务使用 `策问工作区`。`CEWEN_HOME` 可指定独立项目中心；`CEWEN_URL` 可为 CLI/MCP 指定本机回环服务地址。这些环境变量不用于配置独立网页版的文件夹权限。

### 源码结构

```text
src/                   工作台界面、编辑器与图谱交互
shared/                文档模型、解析、设计块与共享业务规则
server/                项目、版本、问询、提案与文件事务服务
browser/               独立网页版的文件系统与平台适配
desktop/               Electron 宿主与发行启动器
integration/           CLI、MCP 与 LLM 协作 Skill
templates/             虚构示例项目
scripts/               构建、打包及资源处理
docs/                  协议、设计说明、验收与发布记录
```

`main` 为共享主线，任务分支使用 `codex/` 前缀。开发协作要求见 [AGENTS.md](AGENTS.md)；修改业务行为时应同步维护协议与验收记录。仓库默认不运行自动化测试套件，按任务执行必要的类型检查、构建和人工验收，并明确记录未覆盖项。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 使用与发行 | [双版本开发与发布](docs/双版本开发与发布.md) · [发行说明](docs/RELEASE_NOTES.md) |
| 文件与 LLM 协作 | [公开项目格式](docs/protocol/PROJECT_FORMAT.md) · [接入协议](docs/protocol/INTEGRATION.md) · [协作 Skill](integration/skills/cewen-collaborate/SKILL.md) · [MCP 能力审计](docs/protocol/MCP_CAPABILITY_AUDIT.md) |
| 文档结构与设计块 | [层级与排序](docs/protocol/HIERARCHY_0.7.md) · [设计块](docs/protocol/DESIGN_BLOCKS_0.6.md) · [公开伴随文件](docs/protocol/DOCUMENT_COMPANIONS_0.6.md) |
| 开发与验证 | [开发方案](docs/策问_正式开发方案_20260922.md) · [执行记录](docs/开发执行记录.md) · [0.7.1 验收记录](docs/protocol/WORKSPACE_REVIEW_0.7.1.md) · [发布检查](docs/protocol/RELEASE_CHECKS.md) |

## 当前边界与许可

当前面向本地单用户使用，采用线性完整快照；尚不包含云同步、多人权限、历史分支合并、自动调用模型或自动更新。导入与备份单包上限为 150 MB、10,000 个文件；与后续内容重叠的撤销可能需要人工合并。桌面包尚未代码签名，独立网页版未提供离线 PWA 安装。

公开仓库只保留软件源码与虚构示例，不应提交真实游戏资料、个人草稿、访问凭证或本机缓存。仓库目前未选定软件开源许可证；源码公开不应被表述为已经采用 MIT、Apache 等许可。第三方依赖的许可与声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [public/licenses/](public/licenses/)。
