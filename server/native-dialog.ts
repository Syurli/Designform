import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectError } from './files.ts';

/** 开发服务和独立本机网页也能选择目录；脚本固定，用户路径仅经环境变量传入。 */
export async function chooseNativeDirectory(initial = ''): Promise<string | null> {
  if (process.platform !== 'win32') throw new ProjectError('PICKER_UNAVAILABLE', '当前宿主未提供目录选择器，请使用桌面版或支持文件夹授权的网页版本。');
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = '选择策问项目文件夹'
$picker.SelectedPath = $env:CEWEN_PICKER_DIRECTORY
if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) }
$picker.Dispose()`;
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, CEWEN_PICKER_DIRECTORY: initial }, maxBuffer: 1024 * 64 });
  return result.stdout.replace(/^\uFEFF/, '').trim() || null;
}
