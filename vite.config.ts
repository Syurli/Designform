import { defineConfig, type Plugin } from 'vite';
import { createProjectApi } from './server/http.ts';
import path from 'node:path';

/** 浏览器构建只替换平台边界，项目解析、版本、事务及问询规则共用。 */
function browserPlatform(): Plugin {
  return { name: 'cewen-browser-platform', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return;
    const target = path.resolve(path.dirname(importer.split('?')[0]),source).replaceAll('\\','/');
    if (target.endsWith('/server/platform.ts')) return path.resolve('browser/platform.ts');
    if (target.endsWith('/server/index-store.ts')) return path.resolve('browser/index-store.ts');
  } };
}

/** 开发与构建预览都接入真实本地项目服务，静态页面不假装已经保存文件。 */
function projectService(): Plugin {
  const api = createProjectApi();
  const middleware = (server: { middlewares: { use: (handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => { void api.handle(request, response).then(handled => { if (!handled) next(); }).catch(next); });
  };
  return { name: 'cewen-local-projects', configureServer(server) { middleware(server); server.httpServer?.once('close', () => api.service.close()); }, configurePreviewServer(server) { middleware(server); server.httpServer.once('close', () => api.service.close()); } };
}

export default defineConfig(({ mode }) => ({ base: mode === 'web' ? '/Designform/' : '/', plugins: [browserPlatform(), ...(mode === 'web' ? [] : [projectService()])], build: { outDir: mode === 'web' ? 'dist-web' : 'dist', target: 'es2022' }, server: { host: '127.0.0.1', watch: { ignored: ['**/release/**', '**/runtime/**', '**/.local/**'] } }, preview: { host: '127.0.0.1' } }));
