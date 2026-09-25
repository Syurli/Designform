import { asNumber, asRows, asString, type CreativeObject } from './model.ts';

export type TimingMode = 'ripple' | 'keep-next';
export interface TimingChange { itemId: string; beforeMs: number; afterMs: number; deltaMs: number }
export interface TimingPreview { sequence: CreativeObject; changes: TimingChange[]; conflicts: string[] }
/** 只构造候选序列；调用方预览并确认后才走正式事务。保持后续位置时显式报告空隙或重叠，不偷偷修改其他镜头。 */
export function changeShotDuration(sequence: CreativeObject, itemId: string, durationMs: number, mode: TimingMode): TimingPreview {
  if (sequence.type !== 'sequence' || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw new Error('镜头时长必须是 1～3600000 的整数毫秒。');
  const next = structuredClone(sequence), items = asRows(next.data.items), at = items.findIndex(i => i.id === itemId);
  if (at < 0) throw new Error('镜头实例不存在。');
  const before = asNumber(items[at].durationMs), delta = durationMs - before;
  if (before < 1) throw new Error('先为序列设定明确时长，再调整节奏。');
  const boundary = items.slice(0, at + 1).reduce((n, i) => n + asNumber(i.durationMs), 0);
  const changes: TimingChange[] = [{ itemId, beforeMs: before, afterMs: durationMs, deltaMs: delta }], conflicts: string[] = [];
  if (mode === 'keep-next') {
    // 下一镜入点保持不变时，长于原时槽的镜头发生重叠。禁止静默截短下一镜。
    if (delta > 0) conflicts.push(`新增 ${delta} ms 超出当前时槽，会与下一镜或序列尾部重叠。请使用“顺延后续”或缩短本镜。`);
    if (delta < 0) conflicts.push(`缩短后留下 ${-delta} ms 空隙。请选择“顺延后续”或保留原时长；本版不自动填黑场。`);
    return { sequence: next, changes, conflicts };
  }
  items[at].durationMs = durationMs;
  for (const cue of asRows(next.data.audio)) {
    const start = asNumber(cue.startMs);
    // 锁定为绝对时码的声音不移动；其他在后续镜头开始的声音与画面一起顺延。
    if (start >= boundary && cue.timingMode !== 'absolute') cue.startMs = start + delta;
  }
  next.data.timingState = 'confirmed';
  return { sequence: next, changes, conflicts };
}
/** 按稳定镜头实例 ID 记录切镜节奏。结果只属于候选，不在按键过程中保存项目。 */
export class TapTimingSession {
  private at = 0;
  private began = 0;
  private values: { itemId: string; durationMs: number }[] = [];
  private active = false;
  constructor(private itemIds: string[], private clock: () => number) {
    if (!itemIds.length || new Set(itemIds).size !== itemIds.length) throw new Error('节奏录制需要不重复的镜头实例身份。');
  }
  start() { this.at = 0; this.values = []; this.began = this.clock(); this.active = true; }
  tap() {
    if (!this.active) return { done: true, index: this.at };
    const now = this.clock(), durationMs = Math.round(now - this.began);
    if (durationMs < 100) throw new Error('相邻切镜少于 100 ms，已忽略，请避免双击。');
    if (durationMs > 3600000) throw new Error('本镜录制超出一小时，请重录。');
    this.values.push({ itemId: this.itemIds[this.at], durationMs }); this.at++; this.began = now;
    if (this.at >= this.itemIds.length) this.active = false;
    return { done: !this.active, index: this.at };
  }
  cancel() { this.active = false; this.values = []; }
  preview(sequence: CreativeObject): TimingPreview {
    if (this.active || this.values.length !== this.itemIds.length) throw new Error('节奏还未全部录完；可以取消，不会改写项目。');
    const next = structuredClone(sequence), items = asRows(next.data.items);
    if (items.length !== this.itemIds.length || items.some((r, i) => r.id !== this.itemIds[i])) throw new Error('镜头顺序已变化，请重新录制。');
    const oldStarts: { id: string; start: number; end: number; nextStart: number }[] = []; let old = 0, fresh = 0;
    const changes = items.map((item, i) => {
      const beforeMs = asNumber(item.durationMs), afterMs = this.values[i].durationMs;
      oldStarts.push({ id: asString(item.id), start: old, end: old + beforeMs, nextStart: fresh });
      old += beforeMs; fresh += afterMs; item.durationMs = afterMs;
      return { itemId: asString(item.id), beforeMs, afterMs, deltaMs: afterMs - beforeMs };
    });
    for (const cue of asRows(next.data.audio)) {
      if (cue.timingMode === 'absolute') continue;
      const before = asNumber(cue.startMs), anchor = oldStarts.find(s => before >= s.start && before < s.end);
      if (anchor) cue.startMs = anchor.nextStart + before - anchor.start;
    }
    next.data.timingState = 'confirmed';
    return { sequence: next, changes, conflicts: [] };
  }
}
