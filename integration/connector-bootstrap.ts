import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
/** MCP 的标准输出只供协议使用；后台宿主由同项目锁保持唯一。 */
const root = path.dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [path.join(root, 'host.js')], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
let connected = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try { const receipt = JSON.parse(await readFile(path.join(root, '../connection.json'), 'utf8')); process.kill(receipt.pid, 0); process.env.CEWEN_URL = receipt.nativeUrl; connected = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
}
if (!connected) throw new Error('本项目接入服务启动失败，请查看项目配置及运行权限。');
await import('./mcp');
