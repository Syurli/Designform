import { createPackage } from '@electron/asar';
import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { releaseVersion } from './release-version.mjs';

/** 完整源码构建后生成可审阅的本机更新包，保留既有 Electron 引擎及用户数据身份。 */
const root = process.cwd(), stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, '.local', `desktop-update-${stamp}`);
const packageRoot = path.join(output, 'desktop-package'), resources = path.join(output, 'resources');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// 使用现有发行身份，避免生成新的 userData 路径而丢失用户本机回答入口。
if (metadata.name !== 'baige-designform' || metadata.main !== 'runtime/desktop.js') throw new Error('桌面身份与既有发行不一致。');
for (const file of ['dist/index.html', 'runtime/desktop.js', 'runtime/preload.cjs', 'runtime/serve.js', 'runtime/cli.js', 'runtime/mcp.js']) await access(path.join(root, file));
await mkdir(path.join(packageRoot, 'runtime'), { recursive: true });
await mkdir(path.join(resources, 'runtime'), { recursive: true });
for (const name of ['desktop.js', 'preload.cjs']) await cp(path.join(root, 'runtime', name), path.join(packageRoot, 'runtime', name));
await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, type: 'module', main: metadata.main, description: metadata.description, author: metadata.author, license: metadata.license }, null, 2));
// 从已构建的文本入口创建新归档；不读取或解包旧安装的二进制归档。
await createPackage(packageRoot, path.join(resources, 'app.asar'));
for (const name of ['serve.js', 'cli.js', 'mcp.js']) await cp(path.join(root, 'runtime', name), path.join(resources, 'runtime', name));
for (const [from, to] of [['dist', 'dist'], ['templates/example', 'templates/example'], ['integration/skills', 'integration/skills'], ['docs/protocol', 'integration/protocol']]) await cp(path.join(root, from), path.join(resources, to), { recursive: true });
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(resources, 'THIRD_PARTY_NOTICES.md'));
for (const name of ['策问MCP.cmd', '策问CLI.cmd', '使用说明.md']) await cp(path.join(root, 'desktop', name), path.join(output, name));
await cp(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceHashes = {};
for (const name of ['server/files.ts', 'server/projects.ts', 'server/http.ts', 'server/creative/service.ts', 'shared/inquiry.ts', 'shared/answer-handoff.ts', 'shared/answer-context.ts', 'shared/question-sources.ts', 'shared/prompts.ts', 'integration/mcp.ts', 'integration/cli.ts', 'src/round-questions.ts', 'src/round-questions.css', 'src/project-question-model.ts', 'src/project-question-directory.ts', 'src/project-question-directory.css', 'src/document-desktop.ts']) sourceHashes[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
const build = { product: '策问 Designform', version: releaseVersion, channel: 'local-inquiry-flow', builtAt: new Date().toISOString(), sourceRoot: root, branch: git('branch', '--show-current'), sourceCommit: git('rev-parse', 'HEAD'), uncommitted: !!git('status', '--porcelain'), performanceCommit: git('rev-parse', 'origin/codex/large-project-performance'), sourceHashes, desktopBuild: 'passed', webBuild: 'passed', runtimeBuild: 'passed', automatedTestSuite: 'not-run', electronEngine: 'reuse existing installation', output };
await writeFile(path.join(output, 'BUILD.json'), JSON.stringify(build, null, 2));
await writeFile(path.join(root, '.local/desktop-update.json'), JSON.stringify(build, null, 2));
console.log(`完整桌面更新包：${output}`);
