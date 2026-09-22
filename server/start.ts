import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startHost } from './host.ts';

/** 开发源码和发布包都通过明确资源根目录启动；运行数据另存在用户目录。 */
const root = process.env.CEWEN_RESOURCES ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = await startHost({ root, port: Number(process.env.PORT ?? 5173) });
console.log(`策问已启动：${host.url}`);
process.once('SIGINT', () => host.close()); process.once('SIGTERM', () => host.close());
