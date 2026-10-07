import { build, transform } from 'esbuild';
import { createPackage } from '@electron/asar';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 本地性能版缺少完整对应源码；只替换已核对的服务文本函数，并重新生成桌面入口。 */
const installation = process.argv[2];
if (!installation) throw new Error('请传入已关闭的本地性能版安装目录。');
const sourceRoot = process.cwd(), output = path.join(sourceRoot, '.local/lock-repair');
const packageRoot = path.join(output, 'desktop-package');
await mkdir(path.join(packageRoot, 'runtime'), { recursive: true });

/** 每个定位片段必须唯一；不同构建结构直接停止，避免替换到无关业务代码。 */
function replaceOnce(text, before, after) {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) throw new Error('安装服务与已核对的构建结构不一致。');
  return text.slice(0, first) + after + text.slice(first + before.length);
}
function functionSection(text) {
  const start = text.indexOf('async function fileLock('), end = text.indexOf('\n// ', start);
  if (start < 0 || end < 0 || text.indexOf('async function fileLock(', start + 1) >= 0) throw new Error('无法唯一定位项目锁函数。');
  const section = text.slice(start, end).trimEnd();
  if (!section.endsWith('}')) throw new Error('项目锁函数边界不完整。');
  return section;
}

const original = await readFile(path.join(installation, 'resources/runtime/serve.js'), 'utf8');
const source = await readFile(path.join(sourceRoot, 'server/files.ts'), 'utf8');
const sourceStart = source.indexOf('async function fileLock<T>(');
if (sourceStart < 0) throw new Error('源码缺少项目锁函数。');
// 源码中的 fileLock 是模块最后一个函数；仅编译这一段，避免替换其他性能逻辑。
const compiled = await transform(source.slice(sourceStart), { loader: 'ts', target: 'node24', charset: 'utf8' });
const lockFunction = compiled.code.trimEnd().replaceAll('path.', 'default2.');
const oldFunction = functionSection(original);
if (!oldFunction.includes('default2.dirname(target)') || !oldFunction.includes('ownerAlive(owner.pid)')) throw new Error('原服务平台绑定与预期不一致。');
let repaired = replaceOnce(original, oldFunction, lockFunction);
// 旧文本服务已使用多个 os 导入；新增唯一的明确导入，避免依赖 esbuild 的临时变量名称。
repaired = replaceOnce(repaired, 'var runtimePid = process.pid;', 'var runtimePid = process.pid;\nvar runtimeHost = __lockRepairHostname().toLowerCase();');
const hostImport = "import { hostname as __lockRepairHostname } from 'node:os';\n";
repaired = hostImport + repaired;
// 反向还原后必须与原服务逐字相同，确认此次修复没有顺带丢弃本地性能优化。
const restored = replaceOnce(replaceOnce(repaired.slice(hostImport.length), lockFunction, oldFunction), 'var runtimePid = process.pid;\nvar runtimeHost = __lockRepairHostname().toLowerCase();', 'var runtimePid = process.pid;');
if (restored !== original) throw new Error('项目锁以外的服务文本发生变化，停止生成修复包。');
await writeFile(path.join(output, 'serve.js'), repaired);

/** 去掉独立服务启动尾部，桌面仍由原生入口启动同一份保留性能逻辑的宿主。 */
const startMarker = '\n// server/start.ts\n';
if (!repaired.includes(startMarker)) throw new Error('原服务缺少独立启动边界。');
// esbuild 也会在模块导入处打印同名注释，实际启动代码位于最后一个模块片段。
const startup = repaired.slice(repaired.lastIndexOf(startMarker));
if (!startup.includes('var host = await startHost(')) throw new Error('独立服务启动尾部与预期不一致。');
const hostOnly = replaceOnce(repaired, startup, '\nexport { startHost, writeBytes, resolveInside };\n');
const hostFile = path.join(output, 'performance-host.mjs');
await writeFile(hostFile, hostOnly);
const bridge = name => ({ contents: `export { ${name} } from ${JSON.stringify(hostFile)};`, resolveDir: sourceRoot, loader: 'js' });
await build({
  entryPoints: ['desktop/main.ts'], outfile: path.join(packageRoot, 'runtime/desktop.js'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', external: ['electron'], charset: 'utf8',
  plugins: [{ name: 'preserve-local-performance-host', setup(builder) {
    builder.onLoad({ filter: /[/\\]server[/\\]host\.ts$/ }, () => bridge('startHost'));
    builder.onLoad({ filter: /[/\\]server[/\\]files\.ts$/ }, () => bridge('writeBytes, resolveInside'));
  } }],
});
await cp(path.join(sourceRoot, 'runtime/preload.cjs'), path.join(packageRoot, 'runtime/preload.cjs'));
const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, type: 'module', main: metadata.main, description: metadata.description, author: metadata.author, license: metadata.license }, null, 2));
// 只创建新的归档；不解包、不读取旧 app.asar，也不重新下载或改动 Electron 引擎。
await createPackage(packageRoot, path.join(output, 'app.asar'));
const hash = value => createHash('sha256').update(value).digest('hex');
await writeFile(path.join(output, 'BUILD.json'), JSON.stringify({
  fix: 'copied-project-lock', builtAt: new Date().toISOString(), sourceRoot,
  originalServiceHash: hash(original), patchedServiceHash: hash(repaired),
  unchangedServiceText: true,
  desktopEntry: 'rebuilt from source with preserved local performance host',
  frontend: 'existing installed assets preserved', automatedTestSuite: 'not-run',
}, null, 2));
console.log(`项目锁修复包已生成：${output}`);
