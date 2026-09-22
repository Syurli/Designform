import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectApi } from './http.ts';

/** 正式宿主只监听本机，共用浏览器与桌面项目服务，不需要 Vite 或源码。 */
export async function startHost(options: { root: string; home?: string; port?: number }) {
  const root = path.resolve(options.root), home = options.home ?? process.env.CEWEN_HOME ?? path.join(os.homedir(), 'Documents', '策问工作区');
  const api = createProjectApi({ home, templateRoot: path.join(root, 'templates/example') });
  const staticRoot = path.join(root, 'dist');
  const server = createServer((request, response) => {
    void (async () => {
      if (await api.handle(request, response)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { response.writeHead(403); response.end(); return; }
      const url = new URL(request.url ?? '/', `http://${host}`), relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(staticRoot, relative), check = path.relative(staticRoot, file);
      if (!check || check.startsWith('..') || path.isAbsolute(check) || !(await stat(file).catch(() => null))?.isFile()) { response.writeHead(404); response.end('Not found'); return; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    })().catch(error => { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('本地服务未完成请求，请保留当前草稿并重试。'); console.error(error); });
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', done); reject(error); };
    const done = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', done); server.listen(port, '127.0.0.1');
  });
  // 重启优先复用本项目中心上次的端口，浏览器会话和本机应急草稿可继续连接。
  let preferredPort = options.port ?? 5173;
  if (options.port === undefined) {
    try { const previous = new URL(JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8')).url); if (previous.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(previous.hostname) && Number(previous.port) > 0) preferredPort = Number(previous.port); } catch { /* 初次运行或旧入口损坏时使用默认端口。 */ }
  }
  try { await listen(preferredPort); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; await listen(0); }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地端口未建立。');
  const url = `http://127.0.0.1:${address.port}`;
  await mkdir(home, { recursive: true }); await writeFile(path.join(home, 'connection.json'), JSON.stringify({ url, pid: process.pid, protocol: 1 }, null, 2));
  return { url, service: api.service, close: () => { api.service.close(); server.close(); } };
}
