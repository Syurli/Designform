# 0.9.0-rc.1 验证记录

此记录描述本地源代码候选。**没有远端提交、main合并、Pages更新、Windows打包或Release发布。** 本会话的 GitHub 工具没有写入操作。

## 环境与来源

源码基线 `719e0152858dd199c666fe9917cedcea1b11bbbf`。通过用户 GitHub Actions 的隔离工作台 artifact 取得源代码、已安装依赖与 Node.js 24.21.0。该 artifact 的上游 npm ci 成功；本次环境未重新从 npm 下载全套依赖。版本修改与新增业务没有引入新的 npm 依赖。

本地为 Linux，使用 Node 24、TypeScript、Vite、esbuild；所有写入检查使用虚构临时项目，没有触碰真实用户目录。默认 CI 和 npm build 不调用额外自动化测试套件；以下为明确手动触发的定向检查。

## 已检查

| 检查 | 结果与边界 |
|---|---|
| TypeScript / 双端 / 运行时 | `npm run build:all` 可执行；Vite仍有大chunk提示，不把构建成功当性能验收 |
| 综合业务协议 | 60份文档、74个对象、18份媒体；18画面、16台词音轨项、78秒计划；无对象错误诊断 |
| 引用与事务 | 地图覆盖层不改源地图；旧哈希冲突拒绝；同请求同内容重试；历史清单有效；当前/历史媒体哈希和完整导出 |
| Quest | 4类示例状态：待答、多轮待答、已答且部分落实、已答且全部落实；提案仍走原采纳服务 |
| 生产 | 候选登记与采用独立；采用同镜头一个画面不错误地让另一画面任务过期；依赖冲突拒绝 |
| 格式迁移 | 原格式1项目不变；升级副本保留原历史manifest字节；旧历史仍按格式1读取；新格式2对象可写入 |
| MCP | 真实SDK Client经stdio连接32工具；capabilities、图片与音频真实MCP内容、schema资源、继续Quest prompt和无效游标错误；没有代答/自我采纳/任意commit工具 |
| Comfy协议夹具 | 本机HTTP仿真，验证确认要求、地址拒绝、同项目并发提交防重、固定prompt注入、pending、收集候选、重复收集、安全取消、uncertain禁止重试 |
| 万类契约 | 身份/哈希匹配，过期源、错误项目拒绝；cameraTransform保持null；不执行实际三维操作 |
| 离线组件界面 | 实际CreativeWorkspace、地图表单、问题状态筛选及保留草稿、Quest作答/续轮、排演播放与定位、候选面板、教程暂停/跳过后恢复、窄窗口；未观察到pageerror |
| 许可 | `npm run licenses` 收集312项运行许可，补入Driver.js原文；示例来源说明独立记录 |
| Release配置 | YAML解析通过；防覆盖与固定SHA逻辑完成源码检查；**没有**在GitHub Actions实际执行新流程 |

## 浏览器验证方法与限制

环境策略禁止浏览器直接访问本地HTTP地址。离线检查在空白页面装入实际组件代码，通过Playwright显式的测试API绑定与Node管道调用真实本地业务handler；没有解除浏览器策略、代理网络或访问真实项目。

因此这验证了组件交互与业务连接，不等于验证生产页面网络、CSP、文件夹授权、OPFS/IndexedDB或整个main入口。截图是离线虚构夹具，不是已部署Pages。排演检查观察了时间推进、切镜和无解码报错，不等于人工听觉评价或长时间音画漂移测量。

## 仍须验证 / 未覆盖

真实Windows Electron安装包、原生文件选择、浏览器文件夹授权与恢复；生产main完整导航及所有modal组合；真实ComfyUI工作流/GPU和生成质量；真实TTS；真实万类；大项目性能与长期媒体缓存；断电/跨进程竞争/全部恢复异常；候选发布与远端Checks；全部操作教程实际练习检测；用户手动验收。

## 可重复执行的检查

```bash
# 仓库根目录，Node.js 24
npm ci
npm run build:all
node scripts/check-090.mjs scenario
node scripts/check-090.mjs migration
node scripts/check-090.mjs connectors
```

以上三个检查各自只创建临时虚构目录。最后一个启动的是仿真Comfy协议服务，不加载模型。

SDK MCP检查需先启动一个**隔离虚构项目中心**的本地服务，并打开/创建一个项目：

```bash
# 使用你的隔离目录与实际端口，不要连到真实游戏项目中心
CEWEN_HOME=/path/to/isolated-fixture PORT=5199 npm run serve
CEWEN_URL=http://127.0.0.1:5199 node scripts/check-090-mcp.mjs
```

此脚本只读协议信息、不代答或采纳。Windows PowerShell设置环境变量使用`$env:CEWEN_HOME`、`$env:PORT`和`$env:CEWEN_URL`语法。

## 判断标准

此候选提供可继续开发和手动检查的实际功能，不是完整0.9.0完成声明。工作包缺口以 `docs/tasks/STATUS_0.9.0.md` 为准；不能因为上述局部检查通过便全部勾选开发总任务。
