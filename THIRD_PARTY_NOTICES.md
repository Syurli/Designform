# 第三方依赖与许可

策问的业务与界面代码自行实现。运行依赖包括 Three.js（MIT）、Lucide（ISC，含 Feather MIT 声明）、Markdown/GFM 解析器（MIT）、YAML（ISC）、MCP TypeScript SDK（MIT）及 Zod（MIT）。

159 项实际安装的非开发、非可选运行依赖均已收集原始 LICENSE/NOTICE/COPYING，见 [发行许可索引](public/licenses/INDEX.md)。完整声明随 public/licenses 复制进 dist 和便携包；原始 three.txt 与 lucide.txt 同时保留。具体版本由 package-lock.json 固定。

Electron 壳及 Chromium / Node 的许可文件由 Electron 发行包随附于便携目录。开发工具不作为用户运行时安装到 node_modules，业务运行时已打包。

技术参考以官方资料为依据：[Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)、[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)、[Node SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。浏览器文件接口参考见 [双版本开发与发布](docs/双版本开发与发布.md)。

网页版还使用 buffer（MIT）、path-browserify（MIT）、@noble/hashes（MIT）、sql.js（MIT，其 SQLite 引擎为公共领域）。sql.js 只在首次读取旧工作记录时延迟加载。
