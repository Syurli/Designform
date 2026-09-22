import type { ProjectDocument, ProjectSnapshot } from '../shared/model.ts';
import { projectAssetUrl } from './project-client';
import { escapeHtml, markdownView, resolveDocumentLink } from './markdown-view';

/** 阅读链接只使用当前修订中的身份；历史预览不会偷读当前版本的摘要。 */
export function projectMarkdown(document: ProjectDocument, snapshot: ProjectSnapshot) {
  const href = (id: string) => `#cewen-doc=${encodeURIComponent(id)}`;
  const names = new Map<string, Set<string>>();
  const add = (name: string, id: string) => { if (name.trim().length < 2) return; const ids = names.get(name) ?? new Set(); ids.add(id); names.set(name, ids); };
  for (const doc of snapshot.documents) if (doc.type === 'dd' || doc.type === 'gdd') {
    add(doc.title, doc.id);
    if (doc.type === 'dd' && !/DD$/i.test(doc.title)) { add(`${doc.title}DD`, doc.id); add(`${doc.title} DD`, doc.id); }
  }
  const terms = new Map<string, string>();
  for (const [name, ids] of names) if (ids.size === 1) { const id = [...ids][0]; if (id !== document.id && snapshot.nodes.some(node => node.id === id && node.status !== 'archived')) terms.set(name, href(id)); }
  return markdownView(document.text, (url, image) => {
    const target = resolveDocumentLink(document.path, url); if (!target) return null;
    if (image || target.path.startsWith('docs/assets/')) return target.path.startsWith('docs/assets/') ? projectAssetUrl(snapshot,target.path) : null;
    const linked = snapshot.documents.find(doc => doc.path === target.path); if (!linked) return null;
    let anchor: string; try { anchor = decodeURIComponent(target.anchor); } catch { return null; }
    const id = linked.id + (anchor ? `/${anchor}` : '');
    return snapshot.nodes.some(node => node.id === id) ? href(id) : null;
  }, terms);
}

/** 鼠标悬停与键盘聚焦共用可停留的预览卡；离开、导航或滚动后清除，避免遮挡正文。 */
export function installReadingPreviews(getSnapshot: () => ProjectSnapshot | undefined) {
  const card = document.createElement('aside'); card.className = 'document-link-preview'; card.id = 'document-link-preview'; card.hidden = true; card.setAttribute('role', 'tooltip'); document.body.append(card);
  let active: HTMLAnchorElement | null = null, showTimer: ReturnType<typeof setTimeout> | undefined, hideTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { clearTimeout(showTimer); clearTimeout(hideTimer); active?.removeAttribute('aria-describedby'); active = null; card.hidden = true; };
  const linkAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLAnchorElement>('.markdown-preview a[href^="#cewen-doc="]') : null;
  const show = (link: HTMLAnchorElement) => {
    if (link === active) { clearTimeout(hideTimer); return; } close(); active = link;
    showTimer = setTimeout(() => {
      const snapshot = getSnapshot(); let id: string; try { id = decodeURIComponent(link.hash.slice('#cewen-doc='.length)); } catch { close(); return; }
      const node = snapshot?.nodes.find(node => node.id === id); if (!node || !link.isConnected) { close(); return; }
      card.innerHTML = `<small>${node.kind === 'rule' ? '设计条目' : node.documentType === 'gdd' ? '游戏总纲' : '专项文档'}${snapshot!.historical ? ` · ${escapeHtml(snapshot!.revisionLabel ?? '历史版本')}` : ''}</small><strong>${escapeHtml(node.title)}</strong><p>${escapeHtml(node.summary.slice(0, 200))}${node.summary.length > 200 ? '…' : ''}</p><span>点击正文链接阅读全文</span>`;
      // 编辑器对话框处于顶层时把卡片放入同一个对话框，保证悬停提示可见。
      (link.closest('dialog') ?? document.body).append(card); card.hidden = false; link.setAttribute('aria-describedby', card.id);
      const rect = link.getBoundingClientRect(), width = card.offsetWidth, height = card.offsetHeight;
      card.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
      card.style.top = `${rect.bottom + height + 14 <= innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)}px`;
    }, 180);
  };
  document.addEventListener('pointerover', event => { const link = linkAt(event.target); if (link) show(link); else if (card.contains(event.target as Node)) clearTimeout(hideTimer); });
  document.addEventListener('pointerout', event => { if (linkAt(event.target) || card.contains(event.target as Node)) { clearTimeout(hideTimer); hideTimer = setTimeout(close, 160); } });
  document.addEventListener('focusin', event => { const link = linkAt(event.target); if (link) show(link); else close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('click', close);
  document.addEventListener('scroll', event => { if (!card.contains(event.target as Node)) close(); }, true);
  window.addEventListener('resize', close);
  return close;
}
