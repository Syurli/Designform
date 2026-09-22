import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

/** 从已提交的矢量源导出网页/桌面规格，不要求构建机器安装中文字体。 */
const source = await readFile('public/icons/cewen-dark.svg');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const frames = [];
for (const size of [...sizes, 512]) {
  const png = await sharp(source).resize(size, size).png().toBuffer();
  await writeFile(`public/icons/cewen-${size}.png`, png);
  if (size <= 256) frames.push({ size, png });
}
for (const theme of ['dark', 'light']) {
  const svg = await readFile(`public/icons/tray-${theme}.svg`);
  await writeFile(`public/icons/tray-${theme}.png`, await sharp(svg).resize(32, 32).png().toBuffer());
}
// Windows ICO 保存多个原生尺寸，任务栏、快捷方式和资源管理器按 DPI 选用。
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
frames.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile('public/icons/cewen.ico', Buffer.concat([directory, ...frames.map(frame => frame.png)]));
await writeFile('public/favicon.svg', source);
console.log('已导出网页图标、九尺寸 ICO 和两种托盘图标。');
