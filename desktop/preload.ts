import { contextBridge, ipcRenderer } from 'electron';

/** 渲染页只拿到主题与枚举菜单动作；不暴露 ipcRenderer、Node 或任意文件路径。 */
contextBridge.exposeInMainWorld('cewenDesktop', {
  theme: () => ipcRenderer.invoke('cewen:theme'),
  setTheme: (theme: unknown) => ipcRenderer.invoke('cewen:set-theme', theme),
  command: (command: unknown) => ipcRenderer.invoke('cewen:command', command),
  onTheme: (callback: (theme: 'dark' | 'light') => void) => {
    const receive = (_event: Electron.IpcRendererEvent, theme: unknown) => { if (theme === 'dark' || theme === 'light') callback(theme); };
    ipcRenderer.on('cewen:theme-changed', receive);
    return () => ipcRenderer.removeListener('cewen:theme-changed', receive);
  },
});
