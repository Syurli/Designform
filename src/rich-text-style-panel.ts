import { createElement, Type } from 'lucide';
import { isWebEdition } from './edition';
import { readLocalFonts } from './local-fonts';
import { emptyTextStyle, normalizeTextStyle, textStyleCss, type TextStyle } from '../shared/text-style';

export const textStyleIcon = () => createElement(Type, { width: 20, height: 20, 'stroke-width': 1.65 }).outerHTML;

/** 浮框挂在顶层，避免自由画布的块裁剪；选区由正文编辑器保留，控件可正常获取焦点。 */
export class RichTextStylePanel {
  private panel = document.createElement('section');
  private families: string[] = [];
  private disposed = false;
  private loading = false;
  private style: TextStyle;
  private search = document.createElement('input');
  private fonts = document.createElement('select');
  private status = document.createElement('p');
  private preview = document.createElement('p');
  private read = document.createElement('button');
  private colors = new Map<'highlight' | 'color' | 'background', HTMLInputElement>();
  constructor(anchor: DOMRect, initial: TextStyle, sample: string, private apply: (patch: Partial<TextStyle>) => void, private closed: (restoreFocus: boolean) => void) {
    this.style = normalizeTextStyle(initial);
    const panel = this.panel; panel.className = 'rich-text-style-panel'; panel.setAttribute('popover', 'manual'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '文字样式');
    const header = document.createElement('header'), title = document.createElement('strong'); title.textContent = '文字样式';
    const done = document.createElement('button'); done.type = 'button'; done.textContent = '完成'; done.onclick = () => this.dispose(true); header.append(title, done);
    const fontLabel = document.createElement('label'); fontLabel.textContent = '字体';
    this.search.type = 'search'; this.search.placeholder = '搜索本机已安装字体'; this.search.setAttribute('aria-label', '搜索本机字体'); this.search.oninput = () => this.renderFonts();
    this.fonts.size = 5; this.fonts.setAttribute('aria-label', '字体'); this.fonts.onchange = () => this.change({ fontFamily: this.fonts.value || null });
    fontLabel.append(this.search, this.fonts);
    this.status.className = 'rich-font-status'; this.status.setAttribute('role', 'status');
    this.read.type = 'button'; this.read.textContent = isWebEdition ? '读取本机字体' : '刷新字体列表'; this.read.onclick = () => void this.loadFonts(true);
    const fontFooter = document.createElement('div'); fontFooter.className = 'rich-font-footer'; fontFooter.append(this.status, this.read);
    const colors = document.createElement('div'); colors.className = 'rich-text-colors';
    for (const [key, label, fallback] of [['highlight', '荧光笔', '#fff29d'], ['color', '字体颜色', '#78baff'], ['background', '字体背景颜色', '#31455e']] as const) {
      const row = document.createElement('label'); row.textContent = label;
      const input = document.createElement('input'); input.type = 'color'; input.value = this.style[key] ?? fallback; input.setAttribute('aria-label', label);
      // 连续挑色直接更新原选区，避免重复开关正文或把颜色插入成文字。
      input.oninput = () => this.change({ [key]: input.value }); this.colors.set(key, input);
      const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '清除'; clear.setAttribute('aria-label', `清除${label}`); clear.onclick = () => this.change({ [key]: null });
      row.append(input, clear); colors.append(row);
    }
    this.preview.className = 'rich-text-style-preview'; this.preview.textContent = sample.slice(0, 100) || '中文字体预览 · Designform Aa';
    const clearAll = document.createElement('button'); clearAll.type = 'button'; clearAll.className = 'rich-text-style-clear'; clearAll.textContent = '清除字体与颜色'; clearAll.onclick = () => this.change(emptyTextStyle());
    panel.append(header, fontLabel, fontFooter, colors, this.preview, clearAll);
    panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); this.dispose(true); } });
    document.body.append(panel); panel.showPopover();
    const width = Math.min(360, innerWidth - 24), top = Math.max(12, Math.min(anchor.bottom + 8, innerHeight - 510));
    Object.assign(panel.style, { width: `${width}px`, left: `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`, top: `${top}px`, maxHeight: `${innerHeight - top - 12}px` });
    this.renderFonts(); this.renderPreview(); document.addEventListener('pointerdown', this.outside, true);
    if (isWebEdition) this.status.textContent = '点击读取，授权后显示本机全部字体。'; else void this.loadFonts();
  }
  private outside = (event: PointerEvent) => { if (event.target instanceof Node && !this.panel.contains(event.target)) this.dispose(false); };
  private change(patch: Partial<TextStyle>) { this.style = normalizeTextStyle({ ...this.style, ...patch }); this.apply(patch); this.renderPreview(); if ('fontFamily' in patch) this.renderFonts(); }
  private renderPreview() {
    this.preview.setAttribute('style', textStyleCss(this.style));
    for (const [key, input] of this.colors) { input.dataset.active = String(Boolean(this.style[key])); if (this.style[key]) input.value = this.style[key]!; input.title = this.style[key] ?? '未设置'; }
  }
  private renderFonts() {
    const query = this.search.value.trim().toLocaleLowerCase(), selected = this.style.fontFamily ?? '';
    const theme = new Option('跟随主题字体', ''); this.fonts.replaceChildren(theme);
    if (selected && !this.families.includes(selected)) this.fonts.append(new Option(`${selected}（保留当前字体）`, selected));
    for (const family of this.families) if (!query || family.toLocaleLowerCase().includes(query) || family === selected) { const option = new Option(family, family); option.style.fontFamily = `"${family.replaceAll('"', '\\"')}"`; this.fonts.append(option); }
    this.fonts.value = selected;
  }
  private async loadFonts(refresh = false) {
    if (this.loading) return; this.loading = true; this.read.disabled = true; this.status.textContent = '正在读取本机字体…';
    try {
      const catalog = await readLocalFonts(refresh); if (this.disposed) return;
      this.families = catalog.families; this.renderFonts();
      this.status.textContent = catalog.source === 'unavailable' ? '当前浏览器不支持本机字体读取；桌面安装版可读取全部系统字体。' : `已读取 ${catalog.families.length} 种本机字体`;
    } catch (error) { if (!this.disposed) this.status.textContent = error instanceof Error ? `读取失败：${error.message}` : '字体读取失败，请重试。'; }
    finally { this.loading = false; if (!this.disposed) this.read.disabled = false; }
  }
  dispose(restoreFocus = false) { if (this.disposed) return; this.disposed = true; document.removeEventListener('pointerdown', this.outside, true); this.panel.hidePopover(); this.panel.remove(); this.closed(restoreFocus); }
}
