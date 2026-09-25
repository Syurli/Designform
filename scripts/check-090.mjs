/** 明确手动运行的定向检查，不加入默认 CI 或 npm test。所有写入只到临时虚构项目。 */
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const selected=process.argv[2];
if(!['scenario','migration','connectors','completion'].includes(selected))throw new Error('用法：node scripts/check-090.mjs scenario|migration|connectors|completion');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('此工程要求 Node.js 24 或更新版本。');
await mkdir('runtime',{recursive:true});
const outfile=path.resolve(`runtime/check-090-${selected}.js`);
await build({entryPoints:[`scripts/check-090-${selected}.ts`],bundle:true,platform:'node',target:'node24',format:'esm',outfile,banner:{js:"import {createRequire as _cr} from 'node:module';const require=_cr(import.meta.url);"}});
const child=spawn(process.execPath,[outfile],{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
