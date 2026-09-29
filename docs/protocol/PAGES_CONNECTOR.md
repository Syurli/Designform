# Pages 本机项目接入

网页首次经用户同意从同源下载 `connector.zip` 和 `connector.manifest.json`。下载在后台完成，完整字节数与 SHA-256 同时通过才标记就绪。OPFS 缓存可以清除，页面关闭中断下载后可重试；未就绪时人工操作项目仍可继续。

项目安装目录仅为 `.cewen/connector`：网页只写整包、清单、项目身份及精确 Pages 来源配置和中文说明，不直接写 Chromium 文件系统可能禁止的 `.cmd/.bat/.exe`。所有启动入口都收在 ZIP 内；用户或本机工具将 `connector.zip` 解压到同级 `runtime` 子目录，正确布局为 `.cewen/connector/runtime/node.exe`。后台入口为 `runtime/启动接入.cmd`，MCP stdio 入口为 `runtime/策问MCP.cmd`。运行时仅 Windows x64 Node 24 portable 与打包服务、MCP 入口，不含 Electron、npm 或源码。构建从 Node 官方固定版本校验 SHASUMS 后打包，包仅生成于忽略的 dist-web，不提交 Git。

后台 host 根据安装位置的相对路径确定项目，核验配置身份，以项目私有锁保证唯一。网页从私有 `connection.json` 回执获得本机地址与五分钟一次配对码。精确 HTTPS Pages origin、回环 Host、项目独立会话和接口项目身份必须同时匹配；OPTIONS 只接受同一来源，无通配 CORS。网页不能调用 `/api/session`、跨项目库操作或任意目录导入导出。

Pages 服务自己的项目库登记和自动恢复点位于 `%LOCALAPPDATA%/策问Pages/<实际项目路径SHA-256>/`，独立于项目目录和桌面 App 数据，不检测或复用 App。路径先取真实路径，Windows 按大小写不敏感身份计算哈希；每个目录只绑定已配置的单一 projectId。自动备份位于该外部数据目录的 `automatic-backups`，避免项目内备份引发递归导出拒绝。项目配置、MCP 启动文件、锁和配对回执仍留在 `.cewen/connector`，接口继续受 projectId 范围保护。人工协议验收可通过专用 `CEWEN_CONNECTOR_HOME` 指向 `.local` 临时数据根；若该覆盖目录落入项目内部，启动直接拒绝，不能伪装备份成功。

配对后网页该项目正文、附件、媒体上传和 SSE 全部走本机服务，断线保留草稿并报错，不静默回落浏览器文件服务。MCP bootstrap 附着同一宿主的本机 API，通过原 API 会话鉴权，多客户端不创建多写入者。事件以 fetch SSE 携带会话头，游标在重连中保留。

首屏与连接面板共用本机接入入口，显示清单大小、版本、真实下载字节、重试和稍后。用户同意后正式项目异步部署，失败不阻断人工使用；检测到私有回执后只在编辑器确认没有未保存正文、草稿或图谱操作时自动配对。已开始编辑时提示先保存再明确接管。配对后的页面禁止再通过浏览器 ProjectService 访问真实项目（包含 read/list 与新项目操作）；其他项目应另开网页。示例临时服务独立保留。

重新双击 `runtime/启动接入.cmd` 会附着原宿主并续发五分钟一次配对码，不再启动第二个项目服务。网页保留已接管身份，即使断线也必须显式重启及配对，不能静默使用浏览器写入。配对凭据只保留于当前页面内存；回执及续发控制凭据仅存项目私有目录。

验收边界：需在 Windows x64 Chrome/Edge 进行启动、浏览器本地网络权限、一次配对、断线、媒体与多个 MCP 客户端的人工验收；默认不执行自动化测试。Pages 构建必须先生成最小包再部署，不能引用尚未存在的 GitHub Release。

## 2026-09-29 计划内人工协议验收

在 `.local/connector-protocol-1790653542410` 创建独立虚构项目，使用当前源码编译实际 host/bootstrap 到该项目 `.cewen/connector/runtime`，通过手动 HTTP 模拟精确 Pages Origin 验收；没有运行测试套件，也没有触碰真实项目。证据留在该目录 `audit-report.json` 和 `mcp-audit-report.json`，属于忽略的本机资料。

- 精确来源 OPTIONS 返回 204 和固定 `Access-Control-Allow-Origin`；错误来源、无会话、错误项目均返回 403。
- 正确一次配对返回真实项目路径，重复使用同码被拒绝；实际等待完整五分钟，过期码返回 403，没有改时钟或缩短生产 TTL。
- 配对后正式快照包含 collaboration 状态，项目库只返回当前一项；外部 `/api/session`、全局 create/open/save-as 被拒绝。
- 原生 MCP 回环 session 保留原鉴权；native 端跨项目 read/create/open 均返回 `PROJECT_SCOPE_DENIED`。
- 带会话头的实际 fetch SSE 收到本项目 reset 和真实 work 事件；虚构验收任务已取消。
- 重复启动继续使用原 PID 和 URL，同时续发一次配对码，未形成第二个项目服务。
- 使用已校验官方 Windows x64 Node portable，在实际 `runtime` 布局运行 ZIP 同款 cmd/VBS 隐藏入口成功。两个独立 stdio MCP 客户端 initialize 及 `cewen_projects` 成功，各自仅看到此项目；两个真实心跳附着同一宿主 PID 和 URL。
- 验收后只结束本轮启动的启动器、MCP 客户端和宿主。检查该虚构运行路径没有残留 Node 进程，项目与记录继续保留。

仍需人工覆盖：真实 Chrome/Edge 的文件夹授权、OPFS 下载/大小及哈希失败重试、浏览器对危险扩展的限制、本地网络访问权限提示、由 ZIP 人工解压后的完整操作、编辑中接管提示、断线保留页面草稿、图片/媒体上传与页面渲染。上述 HTTP 请求并不能替代浏览器权限与视觉验收。最终 Pages 构建需重新生成包含 cmd 启动入口的同源 ZIP；本次验收没有重建 dist-web 包。

## 独立数据目录与自动备份补充验收

发现项目内部的 `ProjectService.home` 会使默认 `automatic-backups` 落进项目，完整导出因递归备份而拒绝；host 已改为上文独立 AppData 数据根与真实项目路径哈希分隔。

在 `.local/connector-backup-1790654598229` 手工初始化新虚构公开项目（未调用会先行自动备份的 ProjectService 创建入口），编译当前 host/bootstrap，并通过 `CEWEN_CONNECTOR_HOME` 指向同级 `independent-pages-data` 启动实际隐藏宿主。实际配对和项目读取成功，`backup-status` 产生一份记录且 `error: null`；读取恢复点 `PACKAGE.json` 核验项目归属正确，恢复点位于独立哈希数据目录并明确在项目外部。跨项目接口仍返回 403；回执继续在项目 `.cewen/connector/connection.json`。证据为该虚构目录 `audit-report.json`，宿主已结束，资料保留；没有向真实 AppData 写验收垃圾，也没有重建 Pages 发行包。
