import { lineDiff } from './compare.ts';

/** 反向应用一个旧批次，只在带上下文的原片段仍唯一匹配时修改，保留之后无关编辑。 */
export function undoText(before: string, after: string, current: string) {
  if (current === after) return before;
  const diff = lineDiff(before, after), ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < diff.length;) {
    if (diff[i].kind === 'same') { i++; continue; }
    const start = i; while (i < diff.length && diff[i].kind !== 'same') i++;
    let a = start, b = i; for (let n = 0; n < 3 && a > 0 && diff[a-1].kind === 'same'; n++) a--;
    for (let n = 0; n < 3 && b < diff.length && diff[b].kind === 'same'; n++) b++;
    // 邻近修改共享上下文时合成一块，避免先替换一块破坏另一块的定位依据。
    const last = ranges.at(-1);
    if (last && a <= last.end) last.end = b; else ranges.push({ start: a, end: b });
  }
  const blocks = ranges.map(range => { const slice = diff.slice(range.start, range.end); return { old: slice.filter(line => line.kind !== 'remove').map(line => line.text).join('\n'), next: slice.filter(line => line.kind !== 'add').map(line => line.text).join('\n') }; });
  for (const block of blocks.reverse()) {
    const position = current.indexOf(block.old);
    if (!block.old || position < 0 || current.indexOf(block.old, position + 1) >= 0) throw new Error('这段内容之后已被修改或无法唯一定位，请使用三方比较手工合并。');
    current = current.slice(0, position) + block.next + current.slice(position + block.old.length);
  }
  return current;
}
