# 本机 Codex 安装版接入记录

## 本轮配置（2026-09-29）

用户要求 Codex 使用最新已安装版，并从安装版读取协作说明、Skill 和协议，不以开发工程作为日常策划接入来源。

- 固定入口：`C:/Users/qbz19/Desktop/01Work/Designform/App/Current`，目录链接当前指向 `0.9.2-local-collaboration`，与桌面“策问 Designform”快捷方式一致。
- 全局 `~/.codex/config.toml` 的 `cewen` 从固定入口启动 `策问MCP.cmd`，cwd 设为 Current；移除旧 0.8.0 路径及写死的 CEWEN_URL，使用策问工作区 connection.json 发现服务。
- 全局 `~/.codex/AGENTS.md` 明确正常策划使用安装版 Skill、protocol、CLI 与使用说明。只有明确的软件开发请求使用 Designform_Dev；用户游戏项目仍按 MCP 返回的独立项目身份访问。
- 本工程 AGENTS.md 记录后续安装维护规则：同步切换已核对的 Current 与桌面快捷方式，只操作目录链接本身，不删除目标安装或用户项目。

## 验证与生效边界

Codex 自带 CLI 的 `mcp get cewen` 已读取新入口、cwd 且没有固定端口环境变量。通过相同安装版启动器手工执行初始化及 tools/list，服务身份 `baige-cewen 0.9.2`，共 38 个工具，包含全部六个 `cewen_work_*`。本次检查没有调用项目工具，也未读取或修改用户策划资料。

证据位于忽略目录 `.local/installed-entry-review/receipt.json`。安装版原生桌面服务当时未运行；本次握手验证的是适配器和工具注册，不宣称已读取项目或完成真实模型创作。现有 Codex 会话仍须重新连接，当前聊天中的旧工具列表不能通过改文件就当作已替换。建议用户重新打开 Codex，并保持策问桌面程序运行。

没有运行自动化测试套件；本轮是配置与说明更新，没有修改应用代码或重新打包，不提交或发布在线版。安装目录 `LOCAL_BUILD.json.installedCodexAccess` 记录该配置及随包文档更新，原始 ZIP 和前端更新来源保留。
