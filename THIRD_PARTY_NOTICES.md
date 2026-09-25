# 第三方依赖与许可

策问的业务与界面代码自行实现。运行依赖包括 Three.js（MIT）、Lucide（ISC，含 Feather MIT 声明）、Markdown/GFM 解析器（MIT）、YAML（ISC）、MCP TypeScript SDK（MIT）及 Zod（MIT）。

312 项实际安装的非开发、非可选运行依赖已收集原始 LICENSE/NOTICE/COPYING，见 [发行许可索引](public/licenses/INDEX.md)。完整声明随 public/licenses 复制进 dist 和便携包；原始 three.txt 与 lucide.txt 同时保留。具体版本由 package-lock.json 固定。

0.5 接入 Milkdown / Crepe 7.22.1（MIT）及其 ProseMirror、CodeMirror 等依赖。remark-math 6.0.0 的 npm 包未附仓库根目录许可，已从对应官方标签提交 `d5d0660b150810a535bbb07eac6cc96a4510aa24` 补入原文；收集脚本固定来源并随包分发。

Electron 壳及 Chromium / Node 的许可文件由 Electron 发行包随附于便携目录。开发工具不作为用户运行时安装到 node_modules，业务运行时已打包。

技术参考以官方资料为依据：[Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)、[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)、[Node SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。浏览器文件接口参考见 [双版本开发与发布](docs/双版本开发与发布.md)。

网页版还使用 buffer（MIT）、path-browserify（MIT）、@noble/hashes（MIT）、sql.js（MIT，其 SQLite 引擎为公共领域）。sql.js 只在首次读取旧工作记录时延迟加载。

0.8 接入 Driver.js 1.8.0（MIT）；0.9 将其封装为教程 DOM 展示适配器。原始许可见 public/licenses/runtime/node_modules_driver.js.txt。0.9 虚构示例的图像与演示声音来源见 templates/creative/README.md，未包含第三方可执行生成器。
