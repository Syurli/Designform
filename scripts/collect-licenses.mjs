import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 收集实际运行依赖的原始许可，随两种发行包分发；不把许可证概述替代原文。 */
const lock = JSON.parse(await readFile('package-lock.json','utf8'));
const lines = ['# 随发行包分发的运行时许可', ''];
await mkdir('public/licenses/runtime',{recursive:true});
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev || entry.optional) continue;
  const metadata = JSON.parse(await readFile(path.join(location,'package.json'),'utf8'));
  const names = (await readdir(location)).filter(name => /^(licen[cs]e|notice|copying)(\.|$)/i.test(name));
  // remark-math 6 的 npm 包漏带仓库根目录许可，固定到该版本官方标签原文。
  const fallback = metadata.name === 'remark-math' && entry.version === '6.0.0' ? 'scripts/licenses/remark-math-6.0.0.txt' : null;
  if (!names.length && !fallback) throw new Error(`未找到运行依赖许可：${metadata.name}`);
  const target = location.replaceAll('/','_') + '.txt';
  const text = await Promise.all(names.map(async name => `--- ${name} ---\n\n${await readFile(path.join(location,name),'utf8')}`));
  if (!names.length && fallback) text.push('来源：https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license\n\n' + await readFile(fallback,'utf8'));
  await writeFile(`public/licenses/runtime/${target}`,`${metadata.name} ${entry.version}\n\n${text.join('\n\n')}`);
  lines.push(`- ${metadata.name} ${entry.version} — ${entry.license ?? metadata.license ?? '见原文'} — [许可](runtime/${target})`);
}
await writeFile('public/licenses/INDEX.md',lines.join('\n')+'\n');
console.log(`已收集 ${lines.length - 2} 项运行依赖许可。`);
