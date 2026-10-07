import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** npm 采用合法 SemVer；用户指定的四段修订号统一用于界面、标签和发行附件。 */
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const releaseVersion = metadata.releaseVersion ?? metadata.version;
const revision = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(releaseVersion);
const expected = revision ? `${revision[1]}+${revision[2]}` : releaseVersion;
if (!/^\d+\.\d+\.\d+(?:\.\d+|-[A-Za-z0-9.-]+)?$/.test(releaseVersion) || metadata.version !== expected) {
  throw new Error('发布版本与 npm 版本不一致；四段修订号须映射为对应的构建编号。');
}
// CI 未安装依赖时也能校验发布号，禁止错误标签进入打包和发布步骤。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(releaseVersion);
