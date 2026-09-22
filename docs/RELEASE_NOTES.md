# 策问 Designform 0.3.0

首次发布共用源码的独立网页版和 Windows 桌面版。

- [直接打开网页版](https://syurli.github.io/Designform/)：桌面 Chrome / Edge 授权本机文件夹后，即可创建、阅读和编辑策划案，文档不上传。
- Windows 用户下载 `Designform-0.3.0-Windows-x64.zip`，解压运行 `策问 Designform.exe`。包内提供 CLI、MCP 和独立协作说明。
- 两端共用 Markdown、历史快照、问询与 JSON 整理记录。保留深浅主题、星图、系统分层、关系分析、策划案及卡片视图。
- 旧 SQLite 整理记录首次只读迁移，原文件保留；请统一升级两端，不同时使用 0.2.x 修改整理记录。

同一项目一次使用一个策问写入端。网页试用示例和自动恢复点保存在浏览器本机存储，需长期保留时导出到磁盘；正式项目始终保存在用户授权目录。网页版采用文件/交换包协作，实时 MCP 使用桌面版。

Windows 包暂未代码签名，没有自动更新。详细边界与发布约定见仓库 [双版本开发与发布](https://github.com/Syurli/Designform/blob/main/docs/双版本开发与发布.md)。
