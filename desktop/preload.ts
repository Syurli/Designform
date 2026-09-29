import { contextBridge, ipcRenderer } from 'electron';

/** 渲染页只拿到主题与枚举菜单动作；不暴露 ipcRenderer、Node 或任意文件路径。 */
contextBridge.exposeInMainWorld('cewenDesktop', {
  theme: () => ipcRenderer.invoke('cewen:theme'),
  setTheme: (theme: unknown) => ipcRenderer.invoke('cewen:set-theme', theme),
  command: (command: unknown) => ipcRenderer.invoke('cewen:command', command),
  // 只接受项目与文档身份，渲染页不能传递任意磁盘路径。
  revealDocument: (projectId: string, documentId: string) => ipcRenderer.invoke('cewen:reveal-document', projectId, documentId),
  // 鼠标侧键的原生导航事件只提供方向枚举，不暴露任意系统命令。
  onNavigation:(callback:(direction:'back'|'forward')=>void)=>{
    const receive=(_event:Electron.IpcRendererEvent,direction:unknown)=>{if(direction==='back'||direction==='forward')callback(direction);};
    ipcRenderer.on('cewen:navigate-history',receive);return ()=>ipcRenderer.removeListener('cewen:navigate-history',receive);
  },
  onTheme: (callback: (theme: 'dark' | 'light') => void) => {
    const receive = (_event: Electron.IpcRendererEvent, theme: unknown) => { if (theme === 'dark' || theme === 'light') callback(theme); };
    ipcRenderer.on('cewen:theme-changed', receive);
    return () => ipcRenderer.removeListener('cewen:theme-changed', receive);
  },
});
