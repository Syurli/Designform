/** 别名写入公开 Markdown 的 aliases 列表；仅供候选匹配，确认引用后才生成链接。 */
export function documentAliases(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，;；\n]/) : [];
  return [...new Set(items.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 20).map(item => item.slice(0, 80));
}
