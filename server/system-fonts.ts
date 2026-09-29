import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
let cached: { families: string[]; source: 'system' } | undefined;
/** 使用 Windows 字体服务读取当前用户及系统已安装的家族名，不扫描或复制字体二进制。 */
export async function installedFonts(refresh = false) {
  if (cached && !refresh) return cached;
  if (process.platform !== 'win32') return { families: [] as string[], source: 'unavailable' as const };
  const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName PresentationCore; $families=[System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source }; ConvertTo-Json -InputObject @($families | Sort-Object -Unique) -Compress';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  const names: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const families = (Array.isArray(names) ? names : [names]).filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  cached = { families: [...new Set(families)].sort((a, b) => a.localeCompare(b, 'zh-CN')), source: 'system' }; return cached;
}
