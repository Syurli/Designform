import { app, BrowserWindow, Menu, shell, dialog, nativeTheme, nativeImage, Tray, ipcMain } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../server/host.ts';
import { writeBytes } from '../server/files.ts';

/** 原生边界仅提供固定菜单动作，文档操作仍经过统一的本机项目服务。 */
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let theme: 'dark' | 'light' = 'dark';
let settingsWrite: Promise<void> = Promise.resolve();
app.setAppUserModelId('com.baige.designform');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  const show = () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); };
  app.on('second-instance', show);
  // ESM 顶层不能等待 ready；主进程初始化完成后再建立窗口与服务。
  void app.whenReady().then(async () => {
    const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
    const root = app.isPackaged ? process.resourcesPath : path.resolve(runtimeRoot, '..');
    const preferences = app.getPath('userData'); await mkdir(preferences, { recursive: true });
    try { if (JSON.parse(await readFile(path.join(preferences, 'appearance.json'), 'utf8')).theme === 'light') theme = 'light'; } catch { /* 首次启动使用已确认的深色主题。 */ }
    const colors = () => theme === 'dark' ? { color: '#0b101d', symbolColor: '#bdcde7', height: 36 } : { color: '#cdd4d9', symbolColor: '#2d414e', height: 36 };
    nativeTheme.themeSource = theme;
    host = await startHost({ root, installation: app.isPackaged ? path.dirname(app.getPath('exe')) : undefined, chooseDirectory: async initial => {
      const settings: Electron.OpenDialogOptions = { title: '选择策问项目文件夹', defaultPath: initial || app.getPath('documents'), properties: ['openDirectory'] };
      const result = window ? await dialog.showOpenDialog(window, settings) : await dialog.showOpenDialog(settings);
      return result.canceled ? null : result.filePaths[0] ?? null;
    } });
    const iconPath = path.join(root, 'dist/icons/cewen.ico');
    // 自绘标题栏负责拖动与菜单，原生最小化、最大化和关闭按钮使用主题覆盖色。
    window = new BrowserWindow({ width: 1500, height: 960, minWidth: 850, minHeight: 650, title: '策问 Designform', icon: iconPath, backgroundColor: colors().color, show: true, titleBarStyle: 'hidden', titleBarOverlay: colors(), webPreferences: { preload: path.join(runtimeRoot, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== host!.url) event.preventDefault(); });
    // 原生菜单栏由主题一致的页面菜单替代，Alt 不会再弹出第二套栏位。
    Menu.setApplicationMenu(null); window.removeMenu();
    let changing = false;
    /** 所有入口调用同一主题更新，快速切换的偏好按顺序落盘。 */
    const setTheme = (value: 'dark' | 'light', save = true) => {
      theme = value; nativeTheme.themeSource = value;
      window?.setBackgroundColor(colors().color); window?.setTitleBarOverlay(colors());
      window?.webContents.send('cewen:theme-changed', value);
      if (tray) {
        tray.setImage(nativeImage.createFromPath(path.join(root, `dist/icons/tray-${value}.png`)));
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '显示策问', click: show },
          { label: '在浏览器打开', click: () => { void shell.openExternal(host!.url); } },
          { type: 'separator' },
          { label: '深色主题', type: 'radio', checked: value === 'dark', click: () => setTheme('dark') },
          { label: '浅色主题', type: 'radio', checked: value === 'light', click: () => setTheme('light') },
          { type: 'separator' }, { label: '退出策问', click: () => app.quit() },
        ]));
      }
      if (save) settingsWrite = settingsWrite.catch(() => {}).then(() => writeBytes(preferences, 'appearance.json', JSON.stringify({ theme: value }, null, 2)));
      return value;
    };
    /** 仅本窗口主框架的同源页面能访问桥接，嵌入页和外部链接都不能调用。 */
    const authorized = (event: Electron.IpcMainInvokeEvent) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === host!.url;
    ipcMain.handle('cewen:theme', event => { if (!authorized(event)) throw new Error('无效的页面来源。'); return theme; });
    ipcMain.handle('cewen:set-theme', async (event, value: unknown) => { if (!authorized(event) || (value !== 'dark' && value !== 'light')) throw new Error('无效的主题请求。'); setTheme(value); await settingsWrite; return value; });
    ipcMain.handle('cewen:command', async (event, command: unknown) => {
      if (!authorized(event)) throw new Error('无效的页面来源。');
      const contents = window!.webContents;
      switch (command) {
        case 'browser': await shell.openExternal(host!.url); break;
        case 'hide': window!.hide(); break;
        case 'quit': app.quit(); break;
        case 'reload': contents.reload(); break;
        case 'undo': contents.undo(); break;
        case 'redo': contents.redo(); break;
        case 'cut': contents.cut(); break;
        case 'copy': contents.copy(); break;
        case 'paste': contents.paste(); break;
        case 'selectAll': contents.selectAll(); break;
        case 'zoomIn': contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + .5)); break;
        case 'zoomOut': contents.setZoomLevel(Math.max(-2, contents.getZoomLevel() - .5)); break;
        case 'resetZoom': contents.setZoomLevel(0); break;
        default: throw new Error('不支持的菜单动作。');
      }
    });
    tray = new Tray(nativeImage.createFromPath(path.join(root, `dist/icons/tray-${theme}.png`)));
    tray.setToolTip('策问 Designform · 百舸'); tray.on('click', show); tray.on('double-click', show); setTheme(theme, false);
    await window.loadURL(host.url); window.show();
    app.on('window-all-closed', () => app.quit());
    // 退出前完成最后一次偏好写入；托盘与本地服务随程序一起关闭。
    app.on('will-quit', event => { if (!changing) { event.preventDefault(); changing = true; void settingsWrite.finally(() => { tray?.destroy(); host?.close(); app.quit(); }); } });
  }).catch(error => { console.error(error); dialog.showErrorBox('策问未能启动', error instanceof Error ? error.message : String(error)); app.quit(); });
}
