/** 临时示例与预设编辑只存在当前页面；各组件共同用它阻止持久缓存。 */
export const transientProjects = new Map<string, 'example' | 'preset'>();
export const isTransientProject = (id?: string | null) => !!id && transientProjects.has(id);
/** 只保存临时 Blob 地址；不通过桌面 HTTP 读取内存示例的附件。 */
export const transientAssetUrls=new Map<string,string>();

/** 尚未正式保存的媒体只提供内存播放地址，与示例会话身份分开。 */
export const draftMediaUrls = new Map<string,string>();
