import type { ProjectSnapshot } from '../../shared/model';
import { asRows, asNumber, asString, type CreativeObject, type CreativeIndex, type Data } from '../../shared/creative/model';
import { acquireMediaUrl } from '../project-client';
import { h } from './render';

type Tool = 'select' | 'point' | 'path' | 'area';
type Point = { x: number; y: number };
const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000;
const pairs = (value: unknown): Point[] => asString(value).split(';').map(s => s.trim().split(',').map(Number))
  .filter(p => p.length === 2 && p.every(Number.isFinite)).map(([x, y]) => ({ x: clamp(x), y: clamp(y) }));
const pointText = (points: Point[]) => points.map(p => `${p.x},${p.y}`).join('; ');

/** 二维标记编辑器：只更改传入对象的当前层；基础地图以只读底层投影。保存仍由原对象表单执行。 */
export function mountMapEditor(host: HTMLElement, object: CreativeObject, index: CreativeIndex, snapshot: ProjectSnapshot, changed: () => void) {
  if (!['map', 'map-use'].includes(object.type)) return () => {};
  const base = object.type === 'map-use' ? index.objects.find(o => o.object.id === object.data.mapId)?.object : undefined;
  const backgroundId = asString((base ?? object).data.mediaId);
  const media = index.objects.find(o => o.object.id === backgroundId)?.object;
  let tool: Tool = 'select', selection = '', drawing: Point[] = [], hiddenBase = false, disposed = false;
  let view = { x: 0, y: 0, size: 1 }, drag: { id: number; key: string; before: Data; start: Point; row: Data } | undefined;
  let releaseBackground:()=>void=()=>{};
  const undo: Data[] = [], redo: Data[] = [];
  const record = () => { undo.push(structuredClone(object.data)); if (undo.length > 60) undo.shift(); redo.length = 0; };
  const emit = () => { changed(); window.dispatchEvent(new CustomEvent('cewen:tutorial-evidence', { detail: { name: 'map-edited', objectId: object.id } })); };
  host.innerHTML = `<section class="map-editor" data-tutorial="map-editor"><header><strong>${object.type === 'map-use' ? '编辑当前覆盖层（共享地图不会改变）' : '编辑共享地图源'}</strong><span data-map-status role="status"></span></header>
    <div class="map-editor-toolbar" role="toolbar" aria-label="二维地图绘制"><button type="button" data-map-tool="select">选择 / 拖动</button><button type="button" data-map-tool="point">添加点</button><button type="button" data-map-tool="path">画路线</button><button type="button" data-map-tool="area">画区域</button><button type="button" data-map-finish>结束绘制</button><button type="button" data-map-cancel>取消绘制</button><button type="button" data-map-undo>撤销</button><button type="button" data-map-redo>重做</button><button type="button" data-map-reset>全图</button>${base ? '<label><input type="checkbox" data-map-hide-base/>隐藏基础标记</label>' : ''}</div>
    <div class="map-editor-canvas"><svg viewBox="0 0 1 1" preserveAspectRatio="none" tabindex="0" aria-label="二维地图：选择标记后可拖动，滚轮缩放，Escape 取消"><defs><pattern id="grid-${h(object.id)}" width=".05" height=".05" patternUnits="userSpaceOnUse"><path d="M .05 0 L 0 0 0 .05" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-width=".001"/></pattern></defs><rect x="0" y="0" width="1" height="1" fill="url(#grid-${h(object.id)})"/><image data-map-background x="0" y="0" width="1" height="1" preserveAspectRatio="none"/><g data-map-base></g><g data-map-layer></g><g data-map-drawing></g></svg></div>
    <div class="map-selection"><label>标注文字<input data-map-label maxlength="200"/></label><label>关联创作对象<select data-map-object><option value="">未指定</option>${index.objects.filter(x => !['media', 'production', 'quest'].includes(x.object.type)).map(x => `<option value="${h(x.object.id)}">${h(x.object.title)}</option>`).join('')}</select></label><button type="button" data-map-delete>删除选中标记</button><button type="button" data-map-quest>对选中标记提问</button></div><small>坐标为 0～1 的二维示意，不推断实际距离或摄影机参数。底图替换或裁切后应人工复核覆盖层。</small></section>`;
  const svg = host.querySelector<SVGSVGElement>('svg')!, status = host.querySelector<HTMLElement>('[data-map-status]')!;
  const selected = () => { const [kind, id] = selection.split(':'); return asRows(object.data[kind]).find(r => r.id === id); };
  function layer(data: Data, editable: boolean) {
    return ['areas', 'paths', 'points'].flatMap(kind => asRows(data[kind]).map(row => {
      const key = `${kind}:${asString(row.id)}`, attrs = editable ? `data-map-mark="${h(key)}" class="${key === selection ? 'selected' : ''}"` : '';
      if (kind === 'points') return `<g ${attrs}><circle cx="${clamp(asNumber(row.x))}" cy="${clamp(asNumber(row.y))}" r=".012"/><text x="${clamp(asNumber(row.x)) + .017}" y="${clamp(asNumber(row.y)) - .013}" font-size=".028">${h(row.label)}</text></g>`;
      return `<${kind === 'areas' ? 'polygon' : 'polyline'} ${attrs} points="${h(pointText(pairs(row.points)).replaceAll(';', ''))}"><title>${h(row.label)}</title></${kind === 'areas' ? 'polygon' : 'polyline'}>`;
    })).join('');
  }
  function draw() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.size} ${view.size}`);
    host.querySelector('[data-map-base]')!.innerHTML = base && !hiddenBase ? layer(base.data, false) : '';
    host.querySelector('[data-map-layer]')!.innerHTML = layer(object.data, true);
    host.querySelector('[data-map-drawing]')!.innerHTML = drawing.length ? `<polyline class="drawing" points="${h(pointText(drawing).replaceAll(';', ''))}"/>${drawing.map(p => `<circle cx="${p.x}" cy="${p.y}" r=".007"/>`).join('')}` : '';
    host.querySelectorAll<HTMLElement>('[data-map-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapTool === tool)));
    const row = selected();
    (host.querySelector('[data-map-label]') as HTMLInputElement).value = asString(row?.label);
    (host.querySelector('[data-map-object]') as HTMLSelectElement).value = asString(row?.objectId);
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('.map-selection input,.map-selection select,.map-selection button').forEach(el => el.disabled = !row);
    (host.querySelector('[data-map-undo]') as HTMLButtonElement).disabled = !undo.length;
    (host.querySelector('[data-map-redo]') as HTMLButtonElement).disabled = !redo.length;
    status.textContent = drawing.length ? `已放置 ${drawing.length} 个顶点；点击“结束绘制”提交到草稿。` : selection ? `已选择 ${selection.split(':')[1]}` : '添加、选择并拖动标记；所有修改先进入当前草稿。';
  }
  const position = (event: PointerEvent | WheelEvent): Point => {
    const matrix = svg.getScreenCTM(); if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: clamp(p.x), y: clamp(p.y) };
  };
  const finish = () => {
    const minimum = tool === 'area' ? 3 : 2; if (drawing.length < minimum) { status.textContent = `请至少绘制 ${minimum} 个顶点。`; return; }
    record(); const kind = tool === 'area' ? 'areas' : 'paths', id = 'mark-' + crypto.randomUUID().slice(0, 12);
    object.data[kind] = [...asRows(object.data[kind]), { id, label: tool === 'area' ? '新区域' : '新路线', points: pointText(drawing) }];
    selection = `${kind}:${id}`; drawing = []; tool = 'select'; emit(); draw();
  };
  host.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.mapTool) { drawing = []; tool = button.dataset.mapTool as Tool; draw(); }
    if (button.hasAttribute('data-map-finish')) finish();
    if (button.hasAttribute('data-map-cancel')) { drawing = []; draw(); }
    if (button.hasAttribute('data-map-reset')) { view = { x: 0, y: 0, size: 1 }; draw(); }
    if (button.hasAttribute('data-map-delete') && selected()) { record(); const [kind, id] = selection.split(':'); object.data[kind] = asRows(object.data[kind]).filter(r => r.id !== id); selection = ''; emit(); draw(); }
    if (button.hasAttribute('data-map-undo') && undo.length) { redo.push(structuredClone(object.data)); object.data = undo.pop()!; emit(); draw(); }
    if (button.hasAttribute('data-map-redo') && redo.length) { undo.push(structuredClone(object.data)); object.data = redo.pop()!; emit(); draw(); }
    if (button.hasAttribute('data-map-quest') && selected()) {
      // 对草稿点提问不能暗示已保存；来源明确标注为当前草稿，用户仍需确认任务。
      window.dispatchEvent(new CustomEvent('cewen:creative-request', { detail: { action: 'quest', objectId: object.id,
        anchor: { objectId: object.id, subObjectId: selected()!.id, excerpt: asString(selected()!.label), sourceRevision: snapshot.revision, draft: true } } }));
    }
  });
  host.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.hasAttribute('data-map-hide-base')) { hiddenBase = input.checked; draw(); return; }
    const row = selected(); if (!row) return;
    if (input.hasAttribute('data-map-label') || input.hasAttribute('data-map-object')) { record(); row[input.hasAttribute('data-map-label') ? 'label' : 'objectId'] = input.value; emit(); draw(); }
  });
  svg.onpointerdown = event => {
    if (event.button !== 0) return; event.preventDefault(); svg.focus(); const p = position(event);
    const key = (event.target as Element).closest<SVGElement>('[data-map-mark]')?.dataset.mapMark;
    if (tool === 'select') {
      selection = key ?? ''; const row = selected();
      if (row) { drag = { id: event.pointerId, key: selection, before: structuredClone(object.data), start: p, row: structuredClone(row) }; svg.setPointerCapture(event.pointerId); }
      draw(); return;
    }
    if (tool === 'point') { record(); const id = 'mark-' + crypto.randomUUID().slice(0, 12); object.data.points = [...asRows(object.data.points), { id, x: p.x, y: p.y, label: '新标记' }]; selection = 'points:' + id; emit(); draw(); }
    else { drawing.push(p); draw(); }
  };
  svg.onpointermove = event => {
    if (!drag || event.pointerId !== drag.id) return; const point = position(event), row = selected(); if (!row) return;
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    if (drag.key.startsWith('points:')) { row.x = clamp(asNumber(drag.row.x) + dx); row.y = clamp(asNumber(drag.row.y) + dy); }
    else row.points = pointText(pairs(drag.row.points).map(p => ({ x: clamp(p.x + dx), y: clamp(p.y + dy) })));
    draw();
  };
  const endDrag = (cancel = false) => { if (!drag) return; const before = drag.before; if (svg.hasPointerCapture(drag.id)) svg.releasePointerCapture(drag.id); drag = undefined;
    if (cancel) object.data = before; else if (JSON.stringify(before) !== JSON.stringify(object.data)) { undo.push(before); redo.length = 0; emit(); } draw(); };
  svg.onpointerup = () => endDrag(); svg.onpointercancel = () => endDrag(true);
  svg.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endDrag(true); drawing = []; draw(); } if (event.key === 'Enter' && drawing.length) { event.preventDefault(); finish(); } };
  svg.addEventListener('wheel', event => { event.preventDefault(); const p = position(event), next = Math.max(.125, Math.min(1, view.size * (event.deltaY > 0 ? 1.15 : .87))), ratio = next / view.size;
    view = { x: Math.max(0, Math.min(1 - next, p.x - (p.x - view.x) * ratio)), y: Math.max(0, Math.min(1 - next, p.y - (p.y - view.y) * ratio)), size: next }; draw(); }, { passive: false });
  if (media?.type === 'media') void acquireMediaUrl(snapshot, asString(media.data.path)).then(lease => { if (disposed) lease.release(); else {releaseBackground=lease.release;host.querySelector('[data-map-background]')?.setAttribute('href', lease.url);} }).catch(() => { status.textContent = '底图无法读取，保留标记编辑与文字资料。'; });
  draw(); return () => { disposed = true; releaseBackground(); endDrag(true); svg.onpointerdown = null; svg.onpointermove = null; svg.onpointerup = null; svg.onpointercancel = null; svg.onkeydown = null; };
}
