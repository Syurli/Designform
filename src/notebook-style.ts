/** 纸张纹理是个人阅读偏好，统一用于整张策划案面板，不写进游戏设计正文。 */
export type NotebookTexture = 'grid' | 'lines' | 'dots' | 'plain';
const textures: NotebookTexture[] = ['grid', 'lines', 'dots', 'plain'];
export function setNotebookTexture(value?: string) {
  let saved = value;
  try { saved ??= localStorage.getItem('cewen-paper-texture') ?? undefined; } catch { /* 禁用存储时仍允许本次切换。 */ }
  const texture = textures.includes(saved as NotebookTexture) ? saved as NotebookTexture : 'grid';
  document.documentElement.dataset.notebookTexture = texture;
  try { localStorage.setItem('cewen-paper-texture', texture); } catch { /* 偏好保存失败不影响文档编辑。 */ }
  return texture;
}
