import { isWebEdition } from './edition';
import { request } from './project-client';

export interface FontCatalog { families: string[]; source: 'system' | 'browser' | 'unavailable' }
let cached: FontCatalog | undefined;
/** 桌面读系统字体服务；网页只在用户点击后请求浏览器字体授权，不把字体数据发送到远程。 */
export async function readLocalFonts(refresh = false): Promise<FontCatalog> {
  if (cached && !refresh) return cached;
  if (!isWebEdition) return cached = await request<FontCatalog>('/api/fonts' + (refresh ? '?refresh=1' : ''));
  const query = (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) return { families: [], source: 'unavailable' };
  const fonts = await query.call(window);
  return cached = { families: [...new Set(fonts.map(font => font.family))].sort((a, b) => a.localeCompare(b, 'zh-CN')), source: 'browser' };
}
