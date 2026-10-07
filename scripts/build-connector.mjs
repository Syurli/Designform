import { build } from 'esbuild';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releaseVersion } from './release-version.mjs';

/** 固定官方 Node 24 运行时；先验证官方 SHASUMS，再取 node.exe。 */
const version = '24.13.0', archive = `node-v${version}-win-x64.zip`;
const staging = path.resolve('.local/connector-build'), runtime = path.join(staging, 'runtime');
// 每次只清理由构建拥有的 staging/runtime，避免旧文件混入最小包。
if (runtime !== path.resolve('.local/connector-build/runtime')) throw new Error('接入包构建目录不匹配。');
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true }); await mkdir('dist-web', { recursive: true });
const base = `https://nodejs.org/dist/v${version}/`;
const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
const expected = sums.split('\n').find(line => line.endsWith('  ' + archive))?.split(/\s+/)[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('官方运行时校验清单缺少目标包。');
const response = await fetch(base + archive); if (!response.ok) throw new Error('官方 Node 下载失败。');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node 官方运行时 SHA-256 校验失败。');
const downloaded = path.join(staging, archive); await writeFile(downloaded, bytes);
if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${downloaded.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}' -Force`]);
else execFileSync('unzip', ['-q', '-o', downloaded, '-d', staging]);
await cp(path.join(staging, `node-v${version}-win-x64/node.exe`), path.join(runtime, 'node.exe'));
await cp(path.join(staging, `node-v${version}-win-x64/LICENSE`), path.join(runtime, 'NODE-LICENSE.txt'));
await build({ entryPoints: { host: 'server/connector-host.ts', bootstrap: 'integration/connector-bootstrap.ts' }, outdir: runtime, bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: false, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
await writeFile(path.join(runtime, 'package.json'), '{"type":"module"}');
await cp('integration/skills', path.join(runtime, 'integration/skills'), { recursive: true });
await mkdir(path.join(runtime, 'integration/protocol'), { recursive: true });
// 同包带齐工具实际引用的中文协议和 schema，接入后不要求读取开发工程源码。
for (const name of ['INTEGRATION.md','COLLABORATION_WORK.md','COLLABORATION_UI.md','PROJECT_CREATION_COLLABORATION.md','PAGES_CONNECTOR.md','QUEST_0.9.md','PROJECT_FORMAT.md','CREATIVE_0.9.md','MEDIA_0.9.md','DOCUMENT_COMPANIONS_0.6.md','commit.schema.json','proposal.schema.json','questions.schema.json']) await cp(path.join('docs/protocol', name), path.join(runtime, 'integration/protocol', name));
// cmd 正文保持 ASCII，中文入口名由文件系统处理，避免不同 Windows 代码页破坏脚本内容。
await writeFile(path.join(runtime, 'start-host.vbs'), 'Set shell = CreateObject("WScript.Shell")\r\nSet fs = CreateObject("Scripting.FileSystemObject")\r\nroot = fs.GetParentFolderName(WScript.ScriptFullName)\r\nshell.Run """" & root & "\\node.exe"" """ & root & "\\host.js""", 0, False\r\n');
await writeFile(path.join(runtime, '启动接入.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nwscript.exe "%~dp0start-host.vbs"\r\n');
await writeFile(path.join(runtime, '策问MCP.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0bootstrap.js"\r\n');
const destination = path.resolve('dist-web/connector.zip');
if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${runtime.replaceAll("'", "''")}/*' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`]);
else execFileSync('zip', ['-q', '-r', destination, '.'], { cwd: runtime });
const result = await readFile(destination);
await writeFile('dist-web/connector.manifest.json', JSON.stringify({ version: releaseVersion, platform: 'win-x64', nodeVersion: version, size: result.length, sha256: createHash('sha256').update(result).digest('hex') }, null, 2));
console.log('Pages 同源 Windows x64 接入包已生成并校验。');
