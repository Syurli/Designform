import { readFile } from 'node:fs/promises';
import { LocalClient } from './client.ts';

/** JSON 从文件或标准输入读取，避免命令行转义破坏中文、换行和原始回答。 */
const client = new LocalClient(), [command, projectId, inputFile] = process.argv.slice(2);
const readInput = async () => {
  if (!inputFile) throw new Error('此命令需要 JSON 文件路径；使用 - 从标准输入读取。');
  let text: string;
  if (inputFile === '-') { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); text = Buffer.concat(chunks).toString('utf8'); }
  else text = await readFile(inputFile, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
};
try {
  if (!command || command === 'help' || command === '--help') console.log('策问 CLI\n\nlist\nread <项目ID>\nhistory <项目ID>\ncontext <项目ID> <范围JSON>\nquestions <项目ID> <问询JSON>\npropose <项目ID> <提案JSON>\nimport-plan <项目ID> <来源JSON>\ncommit <项目ID> <已授权批次JSON>\ncheckpoint <项目ID> <封版JSON>\nbegin-batch <项目ID> <请求JSON>\nend-batch <项目ID> <完成JSON>\n\n先启动策问；CEWEN_URL 可指定本机服务地址。MCP 不提供采纳或任意批次提交工具。');
  else {
    if (command !== 'list' && !/^[A-Za-z0-9_-]+$/.test(projectId ?? '')) throw new Error('需要有效的项目 ID。');
    const prefix = `/api/projects/${projectId}`;
    const routes: Record<string, [string, boolean]> = { list: ['/api/projects', false], read: [prefix, false], history: [`${prefix}/history`, false], context: [`${prefix}/context`, true], questions: [`${prefix}/questions`, true], propose: [`${prefix}/proposals`, true], 'import-plan': [`${prefix}/import-plan`, true], commit: [`${prefix}/commit`, true] };
    routes['begin-batch'] = [`${prefix}/begin-batch`, true]; routes['end-batch'] = [`${prefix}/end-batch`, true];
    routes.checkpoint = [`${prefix}/checkpoint`, true];
    const operation = routes[command]; if (!operation) throw new Error('未知命令，请使用 help 查看。');
    console.log(JSON.stringify(await client.request(operation[0], operation[1] ? await readInput() : undefined), null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
