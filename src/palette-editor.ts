import type { PaletteBlock, PaletteColor } from "../shared/design-blocks";
import "./design-blocks.css";

type Candidate = { hex: string; share: number };
const newId = () => crypto.randomUUID();
const button = (label: string, action: () => void): HTMLButtonElement => { const item = document.createElement("button"); item.type = "button"; item.textContent = label; item.setAttribute("aria-label", label); item.addEventListener("click", action); return item; };
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(value => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const rgb = (value: string): [number, number, number] => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
const srgb = (value: number) => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
/** Lab 距离比直接 RGB 距离更接近人眼感知，输入仍保留 sRGB。 */
function lab(color: [number, number, number]): [number, number, number] {
  const [r, g, b] = color.map(srgb);
  const x = (r * .4124564 + g * .3575761 + b * .1804375) / .95047;
  const y = r * .2126729 + g * .7151522 + b * .072175;
  const z = (r * .0193339 + g * .119192 + b * .9503041) / 1.08883;
  const f = (v: number) => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const distance = (a: [number, number, number], b: [number, number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** 按 alpha 加权的有界采样；透明像素不参与面积。 */
export function extractPalette(image: ImageData, count: number, region?: [number, number, number, number]): Candidate[] {
  const [left, top, width, height] = region ?? [0, 0, image.width, image.height];
  const x0 = Math.max(0, Math.floor(left)), y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(image.width, Math.ceil(left + width)), y1 = Math.min(image.height, Math.ceil(top + height));
  const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, (x1 - x0) * (y1 - y0)) / 24000)));
  const pixels: { rgb: [number, number, number]; lab: [number, number, number]; weight: number }[] = [];
  for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
    const index = (y * image.width + x) * 4, weight = image.data[index + 3] / 255;
    if (weight <= 0) continue;
    const color: [number, number, number] = [image.data[index], image.data[index + 1], image.data[index + 2]];
    pixels.push({ rgb: color, lab: lab(color), weight });
  }
  if (!pixels.length) return [];
  const n = Math.max(3, Math.min(12, Math.round(count), pixels.length));
  // 按最远点播种，让小面积强调色也有机会进入候选群。
  const centers = [pixels[Math.floor(pixels.length / 2)].lab];
  while (centers.length < n) {
    let best = pixels[0], farthest = -1;
    for (const pixel of pixels) { const d = Math.min(...centers.map(center => distance(pixel.lab, center))) * Math.sqrt(pixel.weight); if (d > farthest) { farthest = d; best = pixel; } }
    centers.push(best.lab);
  }
  const groups = Array.from({ length: n }, () => ({ sum: [0, 0, 0], lab: [0, 0, 0], weight: 0 }));
  for (let pass = 0; pass < 10; pass++) {
    groups.forEach(group => { group.sum = [0, 0, 0]; group.lab = [0, 0, 0]; group.weight = 0; });
    for (const pixel of pixels) {
      let closest = 0, minimum = Infinity;
      centers.forEach((center, index) => { const d = distance(pixel.lab, center); if (d < minimum) { minimum = d; closest = index; } });
      const group = groups[closest]; group.weight += pixel.weight;
      for (let channel = 0; channel < 3; channel++) { group.sum[channel] += pixel.rgb[channel] * pixel.weight; group.lab[channel] += pixel.lab[channel] * pixel.weight; }
    }
    groups.forEach((group, index) => { if (group.weight) centers[index] = group.lab.map(value => value / group.weight) as [number, number, number]; });
  }
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  return groups.filter(group => group.weight > 0).map(group => ({ hex: hex(...group.sum.map(value => value / group.weight) as [number, number, number]), share: Math.round(group.weight / total * 1000) / 10 })).sort((a, b) => b.share - a.share);
}

/** 文档内只展示已采纳的设计色板。 */
export function mountPalette(host: HTMLElement, block: PaletteBlock, options: { onEdit?: () => void } = {}): () => void {
  const root = document.createElement("section"); root.className = "cewen-palette-preview"; root.setAttribute("aria-label", `设计色板：${block.title}`);
  const heading = document.createElement("header"); heading.className = "cewen-design-heading"; const title = document.createElement("strong"); title.textContent = block.title; heading.append(title);
  if (options.onEdit) heading.append(button("编辑色板", options.onEdit)); root.append(heading);
  const list = document.createElement("div"); list.className = "cewen-palette-list";
  for (const color of block.colors) { const item = document.createElement("div"); item.className = "cewen-palette-swatch"; const chip = document.createElement("span"); chip.style.backgroundColor = color.hex; chip.setAttribute("aria-label", `颜色 ${color.hex}`); const text = document.createElement("span"); text.textContent = `${color.hex} · ${color.role || "未指定用途"}${color.sourceShare === undefined ? "" : ` · 来源约 ${color.sourceShare}%`}`; item.append(chip, text); list.append(item); }
  root.append(list); host.append(root); return () => root.remove();
}

/** 图片解码始终在本机浏览器完成；resolveImage 可由宿主提供本地附件 Blob。 */
export function openPaletteEditor(block: PaletteBlock | undefined, options: { onSave: (block: PaletteBlock) => void; resolveImage?: (sourcePath: string) => Promise<Blob | string>; storeImage?: (file: File) => Promise<string>; imageUrl?: string; sourcePath?: string; onClose?: () => void }): () => void {
  const draft: PaletteBlock = block ? structuredClone(block) : { kind: "palette", id: newId(), title: "新色板", colors: [] };
  if (options.sourcePath) draft.source = { ...draft.source, path: options.sourcePath };
  let candidates: Candidate[] = []; let count = 5; let image: HTMLImageElement | null = null; let objectUrl: string | null = null;
  let region: [number, number, number, number] | undefined; let status = "设计色板与原图候选分别保存；修改设计色后不再显示原图占比。";
  let storageBusy = false, storageError = false, loadGeneration = 0;
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("dialog"); overlay.className = "cewen-design-overlay"; overlay.setAttribute("aria-label", "编辑色板");
  const root = document.createElement("div"); root.className = "cewen-palette-editor"; overlay.append(root); document.body.append(overlay); overlay.showModal();
  let closed = false;
  const close = () => { if (closed) return; closed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); overlay.close(); overlay.remove(); if (priorFocus?.isConnected) priorFocus.focus(); else document.querySelector<HTMLElement>('dialog[open] .ProseMirror,dialog[open] button[data-action="save-document"]')?.focus(); options.onClose?.(); };
  overlay.addEventListener("cancel", event => { event.preventDefault(); close(); });
  const load = async (value: Blob | string) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = value instanceof Blob ? URL.createObjectURL(value) : null;
    const url = typeof value === "string" ? value : objectUrl!; const loaded = new Image(); loaded.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => { loaded.onload = () => resolve(); loaded.onerror = () => reject(new Error("图片无法读取")); loaded.src = url; });
    image = loaded; region = undefined; status = "图片已在本机读取。选择颜色数量后提取候选。"; render();
  };
  const canvasData = () => {
    if (!image) return null;
    const max = 900, ratio = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, context, data: context.getImageData(0, 0, canvas.width, canvas.height) };
  };
  const render = () => {
    root.replaceChildren();
    const toolbar = document.createElement("header"); toolbar.className = "cewen-design-toolbar";
    toolbar.append(button("返回文档", close)); const name = document.createElement("input"); name.value = draft.title; name.setAttribute("aria-label", "色板标题"); name.addEventListener("input", () => { draft.title = name.value; }); toolbar.append(name);
    const save = button("保存设计色板", () => { if (storageBusy || storageError) return; options.onSave(structuredClone(draft)); close(); }); save.disabled = storageBusy || storageError; toolbar.append(save); root.append(toolbar);
    const columns = document.createElement("div"); columns.className = "cewen-palette-columns"; root.append(columns);
    const source = document.createElement("section"); source.className = "cewen-palette-source"; columns.append(source);
    const h1 = document.createElement("h3"); h1.textContent = "本机图片与候选统计"; source.append(h1);
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/webp,image/gif"; file.setAttribute("aria-label", "选择本机图片"); file.addEventListener("change", () => {
      const item = file.files?.[0]; if (!item) return;
      const generation = ++loadGeneration; storageBusy = true; storageError = false; draft.source = undefined; candidates = [];
      // 更换来源后保留设计色和锁定状态，但旧图面积不能继续归到新图。
      draft.colors.forEach(color => { delete color.sourceShare; });
      status = "正在本机读取并保存图片到当前草稿附件…"; render();
      void (async () => {
        try {
          await load(item);
          if (!options.storeImage) throw new Error("当前入口不能保存图片附件，请从文档编辑页重新选择图片。");
          const path = await options.storeImage(item);
          if (!/^docs\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.includes('..')) throw new Error("图片附件路径无效，未写入色板来源。");
          let hash: string | undefined;
          try { const digest = await crypto.subtle.digest('SHA-256', await item.arrayBuffer()); hash = 'sha256:' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''); } catch { /* 缺少 Web Crypto 时仍保留已保存附件路径。 */ }
          if (closed || generation !== loadGeneration) return;
          draft.source = { path, ...(hash ? { hash } : {}), algorithm: 'local-lab-kmeans-v1' };
          storageBusy = false; status = "图片已保存到当前草稿附件，可重新打开并提取。"; render();
        } catch (error) {
          if (closed || generation !== loadGeneration) return;
          storageBusy = false; storageError = true; status = `图片保存失败：${error instanceof Error ? error.message : String(error)}；当前色板不能保存，请重新选图。`; render();
        }
      })();
    }); source.append(file);
    const countLabel = document.createElement("label"); countLabel.textContent = "候选颜色数量（3—12）"; const slider = document.createElement("input"); slider.type = "range"; slider.min = "3"; slider.max = "12"; slider.value = String(count); slider.setAttribute("aria-label", "候选颜色数量"); slider.addEventListener("input", () => { count = Number(slider.value); countLabel.firstChild!.textContent = `候选颜色数量：${count}`; }); countLabel.append(slider); source.append(countLabel);
    source.append(button("提取区域颜色", () => { try { const result = canvasData(); if (!result) return; candidates = extractPalette(result.data, count, region); if (draft.source) { const ratioX = image!.naturalWidth / result.data.width, ratioY = image!.naturalHeight / result.data.height; if (region) draft.source.region = [Math.round(region[0] * ratioX), Math.round(region[1] * ratioY), Math.round(region[2] * ratioX), Math.round(region[3] * ratioY)]; else delete draft.source.region; draft.source.algorithm = 'local-lab-kmeans-v1'; } status = `已按有效像素 alpha 权重提取 ${candidates.length} 个候选；面积为近似值。`; render(); } catch { status = "无法读取图片像素；请使用本机图片或已授权附件。"; render(); } }), button("改为全图采样", () => { region = undefined; if (draft.source) delete draft.source.region; status = "已清除区域选择，下次提取使用全图。"; render(); }));
    const message = document.createElement("p"); message.className = "cewen-design-muted"; message.textContent = status; if (storageError) message.setAttribute("role", "alert"); source.append(message);
    if (image) {
      const holder = document.createElement("div"); holder.className = "cewen-palette-image-holder"; const display = document.createElement("canvas");
      const data = canvasData(); if (data) { display.width = data.canvas.width; display.height = data.canvas.height; display.getContext("2d")?.drawImage(data.canvas, 0, 0); }
      display.setAttribute("aria-label", "本机图片；拖动框选采样区域，单击取色"); holder.append(display);
      if (region && display.width && display.height) {
        const selection = document.createElement("span"); selection.className = "cewen-palette-region"; selection.style.left = `${region[0] / display.width * 100}%`; selection.style.top = `${region[1] / display.height * 100}%`; selection.style.width = `${region[2] / display.width * 100}%`; selection.style.height = `${region[3] / display.height * 100}%`; holder.append(selection);
      }
      source.append(holder);
      let origin: { x: number; y: number } | null = null;
      const coordinate = (event: PointerEvent) => { const box = display.getBoundingClientRect(); return { x: (event.clientX - box.left) * display.width / box.width, y: (event.clientY - box.top) * display.height / box.height }; };
      display.addEventListener("pointerdown", event => { origin = coordinate(event); display.setPointerCapture(event.pointerId); });
      display.addEventListener("pointerup", event => { if (!origin) return; const end = coordinate(event); const dx = Math.abs(end.x - origin.x), dy = Math.abs(end.y - origin.y);
        if (dx < 5 && dy < 5) { try { const pixel = display.getContext("2d")?.getImageData(Math.floor(end.x), Math.floor(end.y), 1, 1).data; if (pixel && pixel[3]) { candidates.unshift({ hex: hex(pixel[0], pixel[1], pixel[2]), share: 0 }); status = "已取点色；单点没有面积占比。"; } } catch { status = "无法读取此图片的像素。"; } }
        else { region = [Math.min(origin.x, end.x), Math.min(origin.y, end.y), dx, dy]; status = "已选择图片区域，点击提取区域颜色。"; }
        origin = null; render(); });
    }
    const candidateTitle = document.createElement("h4"); candidateTitle.textContent = "提取候选 · 原图近似面积"; source.append(candidateTitle);
    for (const candidate of candidates) { const row = document.createElement("div"); row.className = "cewen-palette-row"; const chip = document.createElement("span"); chip.className = "cewen-palette-chip"; chip.style.backgroundColor = candidate.hex; const label = document.createElement("span"); label.textContent = `${candidate.hex} · ${candidate.share ? `约 ${candidate.share}%` : "点选取色"}`; row.append(chip, label, button("采纳", () => { draft.colors.push({ id: newId(), hex: candidate.hex, sourceShare: candidate.share || undefined }); render(); })); source.append(row); }
    const design = document.createElement("section"); design.className = "cewen-palette-design"; columns.append(design);
    const h2 = document.createElement("h3"); h2.textContent = "设计色板"; design.append(h2);
    design.append(button("添加颜色", () => { draft.colors.push({ id: newId(), hex: "#808080" }); render(); }));
    for (const color of draft.colors) {
      const row = document.createElement("div"); row.className = "cewen-palette-edit-row";
      const swatch = document.createElement("input"); swatch.type = "color"; swatch.value = color.hex; swatch.setAttribute("aria-label", "修改设计颜色"); swatch.disabled = Boolean(color.locked); swatch.addEventListener("input", () => { color.hex = swatch.value.toUpperCase(); delete color.sourceShare; value.value = color.hex; share.textContent = "手工设计色"; }); row.append(swatch);
      const value = document.createElement("input"); value.value = color.hex; value.setAttribute("aria-label", "HEX 色值"); value.disabled = Boolean(color.locked); value.addEventListener("change", () => { const next = value.value.toUpperCase(); if (/^#[0-9A-F]{6}$/.test(next)) { color.hex = next; swatch.value = next; delete color.sourceShare; share.textContent = "手工设计色"; } else value.value = color.hex; }); row.append(value);
      const role = document.createElement("input"); role.value = color.role ?? ""; role.placeholder = "用途：主色/辅色/强调色…"; role.setAttribute("aria-label", "颜色用途"); role.addEventListener("input", () => { color.role = role.value; }); row.append(role);
      const intent = document.createElement("input"); intent.value = color.intent ?? ""; intent.placeholder = "色彩意图"; intent.setAttribute("aria-label", "色彩意图"); intent.addEventListener("input", () => { color.intent = intent.value; }); row.append(intent);
      const share = document.createElement("small"); share.textContent = color.sourceShare === undefined ? "手工设计色" : `原图候选约 ${color.sourceShare}%`; row.append(share);
      row.append(button(color.locked ? "解锁" : "锁定", () => { color.locked = !color.locked; render(); }), button("复制色值", () => { void navigator.clipboard?.writeText(color.hex); }), button("上移", () => { const index = draft.colors.indexOf(color); if (index > 0) [draft.colors[index - 1], draft.colors[index]] = [draft.colors[index], draft.colors[index - 1]]; render(); }), button("下移", () => { const index = draft.colors.indexOf(color); if (index < draft.colors.length - 1) [draft.colors[index + 1], draft.colors[index]] = [draft.colors[index], draft.colors[index + 1]]; render(); }), button("删除", () => { draft.colors = draft.colors.filter(item => item !== color); render(); }));
      design.append(row);
    }
  };
  render();
  const sourcePath = options.sourcePath ?? block?.source?.path;
  if (options.imageUrl) void load(options.imageUrl).catch(error => { status = String(error); render(); });
  else if (sourcePath && options.resolveImage) void options.resolveImage(sourcePath).then(load).catch(error => { status = String(error); render(); });
  return close;
}
