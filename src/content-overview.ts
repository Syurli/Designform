import type { ProjectDocument, ProjectSnapshot } from '../shared/model.ts';
import { countDocumentContent, type ContentStatistics } from '../shared/content-statistics.ts';
import { inkCompanionPath, parseInkCompanion } from '../shared/document-companion.ts';
import './content-overview.css';

type DocumentRow = { document: ProjectDocument; statistics: ContentStatistics; annotationFiles: number };
const numberText = (value: number) => value.toLocaleString('zh-CN');

/** 编辑器底栏直接使用当前 Markdown；未保存提示由调用方按草稿状态显示。 */
export function documentContentSummary(markdown: string): string {
  try {
    const result = countDocumentContent(markdown);
    return `正文 ${numberText(result.characters)} 字符 · 图片 ${result.imageReferences} · 对白 ${result.dialogueNodes} 节点`;
  } catch {
    return '正文统计暂不可用';
  }
}

/** CSV 字段包含用户文案时转义引号及公式前缀，导出后仍能安全核对原文。 */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function appendText(parent: HTMLElement, tag: string, value: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

/** 当前快照或只读历史快照都从已保存 Markdown 重算，草稿不混入项目报表。 */
export function openContentOverview(snapshot: ProjectSnapshot): void {
  const rows: DocumentRow[] = snapshot.documents.filter(item => item.type !== 'guide').map(document => {
    const ink = snapshot.companions?.[inkCompanionPath(document.id)];
    let parsed;
    try { parsed = ink ? parseInkCompanion(ink.text, inkCompanionPath(document.id)) : undefined; }
    catch { /* 快照诊断负责说明损坏文件；统计仍可展示其余文档。 */ }
    return { document, statistics: countDocumentContent(document.text, { ink: parsed }), annotationFiles: snapshot.files?.[`docs/annotations/${document.id}.md`] ? 1 : 0 };
  });
  const total = (key: keyof ContentStatistics) => rows.reduce((sum, row) => sum + row.statistics[key], 0);
  const annotationCount = total('annotations') + rows.reduce((sum, row) => sum + row.annotationFiles, 0);

  const dialog = document.createElement('dialog');
  dialog.className = 'content-overview-dialog';
  document.body.append(dialog);
  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  dialog.addEventListener('close', () => dialog.remove(), { once: true });

  const header = appendText(dialog, 'header', '', 'content-overview-header');
  const heading = document.createElement('div');
  appendText(heading, 'span', '内容概览', 'content-overview-kicker');
  appendText(heading, 'h1', snapshot.project.name);
  appendText(heading, 'p', `统计来源：${snapshot.historical ? '历史版本' : '当前已保存版本'} ${snapshot.revisionLabel ?? '尚无版本'} · ${snapshot.revision ?? '尚无修订 ID'}。未保存草稿不计入。`);
  header.append(heading);
  const closeButton = appendText(header, 'button', '关闭', 'content-overview-close') as HTMLButtonElement;
  closeButton.type = 'button'; closeButton.setAttribute('aria-label', '关闭内容概览'); closeButton.addEventListener('click', close);

  const cards = appendText(dialog, 'section', '', 'content-overview-cards');
  cards.setAttribute('aria-label', '项目统计');
  for (const [label, value] of [
    ['正文字符', total('characters')], ['文档', rows.length], ['图片引用', total('imageReferences')],
    ['表格', total('tables')], ['对白节点', total('dialogueNodes')], ['色板', total('palettes')],
  ] as [string, number][]) {
    const card = appendText(cards, 'div', '', 'content-overview-card');
    appendText(card, 'strong', numberText(value)); appendText(card, 'span', label);
  }

  const note = appendText(dialog, 'p', `另有公开注释 ${numberText(annotationCount)} 项 · 中文汉字 ${numberText(total('chineseCharacters'))} · 外语词 ${numberText(total('foreignWords'))} · 图片去重按各文档计算。`, 'content-overview-note');
  note.id = 'content-overview-note';

  const controls = appendText(dialog, 'div', '', 'content-overview-controls');
  const search = appendText(controls, 'input', '', 'content-overview-search') as HTMLInputElement;
  search.type = 'search'; search.placeholder = '搜索文档名称、分类或路径'; search.setAttribute('aria-label', search.placeholder);
  const count = appendText(controls, 'span', '', 'content-overview-count');
  const exportButton = appendText(controls, 'button', '导出 CSV', 'content-overview-export') as HTMLButtonElement;
  exportButton.type = 'button';

  const tableWrap = appendText(dialog, 'div', '', 'content-overview-table-wrap');
  const table = document.createElement('table'); table.className = 'content-overview-table'; tableWrap.append(table);
  const tableHead = document.createElement('thead'); table.append(tableHead);
  const headRow = document.createElement('tr'); tableHead.append(headRow);
  for (const label of ['文档', '分类', '正文字符', '中文', '外语词', '图片', '表格', '对白', '色板', '注释']) appendText(headRow, 'th', label);
  const body = document.createElement('tbody'); table.append(body);
  const groupNames = new Map(snapshot.groups.map(group => [group.id, group.label]));
  const render = () => {
    body.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const visible = rows.filter(row => `${row.document.title} ${row.document.path} ${groupNames.get(row.document.system) ?? row.document.system}`.toLocaleLowerCase().includes(query));
    for (const row of visible) {
      const tr = document.createElement('tr'); body.append(tr);
      const titleCell = document.createElement('td'); tr.append(titleCell);
      appendText(titleCell, 'strong', row.document.title);
      appendText(titleCell, 'small', row.document.path);
      for (const value of [(groupNames.get(row.document.system) ?? row.document.system) || '未归组', numberText(row.statistics.characters), numberText(row.statistics.chineseCharacters), numberText(row.statistics.foreignWords), numberText(row.statistics.imageReferences), numberText(row.statistics.tables), numberText(row.statistics.dialogueNodes), numberText(row.statistics.palettes), numberText(row.statistics.annotations + row.annotationFiles)]) appendText(tr, 'td', value);
    }
    if (!visible.length) { const tr = document.createElement('tr'); const cell = appendText(tr, 'td', '没有匹配的文档。'); cell.setAttribute('colspan', '10'); body.append(tr); }
    count.textContent = `显示 ${visible.length} / ${rows.length} 份文档`;
  };
  search.addEventListener('input', render);
  exportButton.addEventListener('click', () => {
    const header = ['项目', '修订', '文档 ID', '标题', '路径', '分类', '正文字符', '中文汉字', '外语词', '图片引用', '去重附件', '表格', '标题', '链接', '代码字符', '对白节点', '对白台词', '对白选项', '色板', '色板颜色', '公开注释'];
    const lines = [header, ...rows.map(row => [snapshot.project.name, snapshot.revisionLabel ?? '', row.document.id, row.document.title, row.document.path, groupNames.get(row.document.system) ?? row.document.system, row.statistics.characters, row.statistics.chineseCharacters, row.statistics.foreignWords, row.statistics.imageReferences, row.statistics.uniqueAttachments, row.statistics.tables, row.statistics.headings, row.statistics.links, row.statistics.codeCharacters, row.statistics.dialogueNodes, row.statistics.dialogueLines, row.statistics.dialogueChoices, row.statistics.palettes, row.statistics.paletteColors, row.statistics.annotations + row.annotationFiles])];
    const csv = `\uFEFF${lines.map(line => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `策问-内容概览-${snapshot.revisionLabel ?? '当前稿'}.csv`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render(); dialog.showModal(); search.focus();
}
