import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { parseDesignBlock, serializeDesignBlock } from '../shared/design-blocks';
import type { DesignBlock, DialoguePositions, DialogueBlock, PaletteBlock } from '../shared/design-blocks';
import { mountDialoguePreview, openDialogueEditor } from './dialogue-editor';
import type { DialoguePreviewState } from './dialogue-editor';
import { mountPalette, openPaletteEditor } from './palette-editor';
import './rich-document-plugins.css';

/** 标题折叠只保存在当前编辑器实例，绝不修改 Markdown 正文。 */
const foldingKey = new PluginKey<Set<number>>('cewen-heading-folding');
export function headingFoldingPlugin() {
  return new Plugin<Set<number>>({
    key: foldingKey,
    state: {
      init: () => new Set<number>(),
      apply(transaction, previous, _oldState, state) {
        const mapped = new Set<number>();
        for (const position of previous) {
          const next = transaction.mapping.map(position);
          if (state.doc.nodeAt(next)?.type.name === 'heading') mapped.add(next);
        }
        const toggle = transaction.getMeta(foldingKey) as { toggle: number } | undefined;
        if (toggle) { if (mapped.has(toggle.toggle)) mapped.delete(toggle.toggle); else mapped.add(toggle.toggle); }
        return mapped;
      },
    },
    props: {
      decorations(state) {
        const folded = foldingKey.getState(state) ?? new Set<number>();
        const decorations: Decoration[] = [];
        const headings: { position: number; level: number; size: number }[] = [];
        state.doc.forEach((node, position) => {
          if (node.type.name === 'heading') headings.push({ position, level: Number(node.attrs.level ?? 1), size: node.nodeSize });
        });
        // 按章节层级逐一标记隐藏范围；内容仍完整留在 ProseMirror 文档里。
        const hidden: [number, number][] = [];
        for (let index = 0; index < headings.length; index++) {
          const heading = headings[index]; if (!folded.has(heading.position)) continue;
          const next = headings.slice(index + 1).find(item => item.level <= heading.level);
          hidden.push([heading.position + heading.size, next?.position ?? state.doc.content.size]);
        }
        const isHidden = (position: number) => hidden.some(([from, to]) => position >= from && position < to);
        state.doc.forEach((node, position) => {
          if (isHidden(position)) decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'cewen-folded-content' }));
          // 锚点行的样式由 ProseMirror 装饰维护，NodeView 不直接修改父段落 DOM。
          if (node.type.name === 'paragraph' && /^(?:◇\s*知识条目)?$/.test(node.textContent.trim())) {
            let hasAnchor = false;
            node.descendants(child => { if (child.type.name === 'html' && /^<\/?a(?:\s+id=["'][A-Za-z0-9_-]+["'])?\s*>\s*(?:<\/a>)?\s*$/i.test(String(child.attrs.value ?? '').trim())) hasAnchor = true; });
            if (hasAnchor) decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'cewen-anchor-label-row' }));
          }
        });
        for (const heading of headings) {
          if (isHidden(heading.position)) continue;
          decorations.push(Decoration.widget(heading.position + 1, view => {
            const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'cewen-heading-arrow'; arrow.textContent = folded.has(heading.position) ? '▸' : '▾';
            arrow.setAttribute('aria-label', `${folded.has(heading.position) ? '展开' : '折叠'}标题：${state.doc.nodeAt(heading.position)?.textContent || '未命名标题'}`);
            arrow.setAttribute('aria-expanded', String(!folded.has(heading.position))); arrow.contentEditable = 'false';
            arrow.addEventListener('mousedown', event => event.preventDefault());
            arrow.addEventListener('click', event => {
              event.preventDefault(); event.stopPropagation();
              const editor = view as EditorView;
              const selection = TextSelection.near(editor.state.doc.resolve(heading.position + 1));
              editor.dispatch(editor.state.tr.setSelection(selection).setMeta(foldingKey, { toggle: heading.position }).setMeta('addToHistory', false));
            });
            return arrow;
          }, { side: -1, key: `heading-${heading.position}` }));
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

export interface RichDesignOptions {
  getDialoguePositions?: (id: string) => DialoguePositions | undefined;
  onDialoguePositions?: (id: string, positions: DialoguePositions) => void;
  resolveImage?: (sourcePath: string) => Promise<Blob | string>;
  storeImage?: (file: File) => Promise<string>;
}

/** 公开知识锚点仍是原 HTML 节点，但富文本里只留零宽定位标记。 */
export function anchorHtmlView() {
  return (initial: ProseNode): NodeView => {
    const dom = document.createElement('span');
    let renderedValue: string | undefined;
    const render = (node: ProseNode) => {
      const value = String(node.attrs.value ?? '');
      // 编辑相邻正文会反复调用 update；相同 HTML 不再写 DOM，避免观察器回读。
      if (value === renderedValue) return;
      renderedValue = value;
      const match = /^<a\s+id=["']([A-Za-z0-9_-]+)["']\s*>\s*(?:<\/a>)?\s*$/i.exec(value.trim());
      if (match) {
        dom.className = 'cewen-anchor-token'; dom.id = match[1]; dom.dataset.anchorId = match[1]; dom.title = `知识锚点：${match[1]}`; dom.setAttribute('aria-label', `知识锚点：${match[1]}`); dom.textContent = '';
      } else if(/^<\/a>\s*$/i.test(value.trim())) { dom.className='cewen-anchor-token';dom.removeAttribute('id');dom.removeAttribute('data-anchor-id');dom.textContent='';
      } else { dom.className = 'cewen-other-html'; dom.removeAttribute('id'); dom.removeAttribute('data-anchor-id'); dom.title = ''; dom.textContent = value; }
    };
    render(initial);
    return {
      dom,
      update(node) { if (node.type.name !== 'html') return false; render(node); return true; },
      stopEvent: () => true,
      // 锚点没有 contentDOM；类名、属性和占位文字都由 NodeView 自己维护。
      // 不回传给 ProseMirror 解析，否则 DOM 更新可触发再次 update。
      ignoreMutation: () => true,
    };
  };
}

/** code_block NodeView：普通代码维持可编辑，设计块读取同一段 YAML 作预览。 */
export function designCodeBlockView(options: RichDesignOptions = {}) {
  return (initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    const dom = document.createElement('div'); let contentDOM: HTMLElement | undefined; let disposePreview: (() => void) | undefined;
    const previewState: DialoguePreviewState = { cursor: '', path: [], variables: {} };
    const save = (block: DesignBlock) => {
      const position = getPos(); if (typeof position !== 'number') return;
      const current = view.state.doc.nodeAt(position); if (!current || current.type.name !== 'code_block') return;
      const yaml = serializeDesignBlock(block);
      view.dispatch(view.state.tr.replaceWith(position + 1, position + current.nodeSize - 1, view.state.schema.text(yaml)));
    };
    const render = (node: ProseNode) => {
      disposePreview?.(); disposePreview = undefined; dom.replaceChildren(); contentDOM = undefined;
      const language = String(node.attrs.language ?? '').toLowerCase();
      if (language !== 'cewen-dialogue' && language !== 'cewen-palette') {
        dom.className = 'cewen-ordinary-code'; const pre = document.createElement('pre'); const code = document.createElement('code'); pre.append(code); dom.append(pre); contentDOM = code; return;
      }
      dom.className = 'cewen-rich-design-block';
      try {
        const block = parseDesignBlock(language, node.textContent);
        if (!block) throw new Error('设计块语言不受支持');
        if (block.kind === 'dialogue') disposePreview = mountDialoguePreview(dom, block, { state: previewState, onEdit: () => openDialogueEditor(block, {
          positions: options.getDialoguePositions?.(block.id),
          onSave: (updated, positions) => { save(updated); options.onDialoguePositions?.(block.id, positions); },
        }) });
        else disposePreview = mountPalette(dom, block, { onEdit: () => openPaletteEditor(block, { onSave: save, resolveImage: options.resolveImage, storeImage: options.storeImage, sourcePath: block.source?.path }) });
      } catch (error) {
        const warning = document.createElement('p'); warning.className = 'cewen-design-error'; warning.textContent = `设计块格式有误：${error instanceof Error ? error.message : '无法解析'}`; dom.append(warning);
        const pre = document.createElement('pre'); const code = document.createElement('code'); pre.append(code); dom.append(pre); contentDOM = code;
      }
    };
    render(initial);
    return {
      dom,
      get contentDOM() { return contentDOM; },
      update(node) {
        if (node.type.name !== 'code_block') return false;
        // 普通代码文本由 ProseMirror 管理，避免每次输入重建节点与中文输入法。
        if (contentDOM && !dom.classList.contains('cewen-rich-design-block') && !['cewen-dialogue', 'cewen-palette'].includes(String(node.attrs.language ?? '').toLowerCase())) return true;
        render(node); return true;
      },
      stopEvent(event) { return !!(event.target instanceof Element && event.target.closest('.cewen-dialogue-preview,.cewen-palette-preview')); },
      // 只有普通代码的真实编辑区交给 ProseMirror 观察；预览与包装 DOM 由 NodeView 维护。
      ignoreMutation(mutation) { return !contentDOM || !(mutation.target === contentDOM || contentDOM.contains(mutation.target)); },
      destroy() { disposePreview?.(); },
    };
  };
}

/** Markdown 阅读视图可先输出占位，再调用此函数在原位置挂载同一预览。 */
export function mountDesignBlocks(host: HTMLElement, options: { onEdit?: (block: DesignBlock) => void } = {}): () => void {
  const disposers: (() => void)[] = [];
  host.querySelectorAll<HTMLElement>('[data-design-language][data-design-source]').forEach(placeholder => {
    try {
      const block = parseDesignBlock(placeholder.dataset.designLanguage ?? '', placeholder.dataset.designSource ?? '');
      if (!block) return;
      placeholder.replaceChildren();
      const onEdit = options.onEdit ? () => options.onEdit!(block) : undefined;
      disposers.push(block.kind === 'dialogue' ? mountDialoguePreview(placeholder, block, { onEdit }) : mountPalette(placeholder, block, { onEdit }));
    } catch (error) {
      placeholder.textContent = `设计块格式有误：${error instanceof Error ? error.message : '无法解析'}`;
    }
  });
  return () => disposers.forEach(dispose => dispose());
}
