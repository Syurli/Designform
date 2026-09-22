import { build } from 'esbuild';

/** 宿主和接入适配器打包为独立文件，发行版不需要用户阅读或安装源码依赖。 */
await build({ entryPoints: { 'desktop': 'desktop/main.ts', 'serve': 'server/start.ts', 'cli': 'integration/cli.ts', 'mcp': 'integration/mcp.ts' }, outdir: 'runtime', bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['electron'], sourcemap: false, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
// 沙箱预加载脚本使用 CommonJS，仅依赖 Electron 允许的桥接模块。
await build({ entryPoints: ['desktop/preload.ts'], outfile: 'runtime/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
console.log('本地服务、桌面入口、CLI 与 MCP 已打包。');
