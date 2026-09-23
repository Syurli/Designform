import type { DialogueBlock, DialogueChoice, DialogueCondition, DialogueNode, DialoguePositions } from "../shared/design-blocks";
import "./design-blocks.css";

type Variables = Record<string, string | number | boolean>;
/** 预演位置属于界面状态，不进入正式对白 YAML。 */
export interface DialoguePreviewState { cursor: string; path: { nodeId: string; variables: Variables }[]; variables: Variables; showPath?: boolean }
const id = () => crypto.randomUUID();
const clone = (block: DialogueBlock): DialogueBlock => structuredClone(block);
const button = (label: string, action: () => void, className = ""): HTMLButtonElement => {
  const element = document.createElement("button"); element.type = "button"; element.textContent = label;
  element.className = className; element.setAttribute("aria-label", label); element.addEventListener("click", action); return element;
};
const input = (label: string, value: string, change: (value: string) => void): HTMLElement => {
  const wrap = document.createElement("label"); wrap.className = "cewen-design-field"; wrap.textContent = label;
  const field = document.createElement("input"); field.value = value; field.setAttribute("aria-label", label); field.addEventListener("input", () => change(field.value)); wrap.append(field); return wrap;
};
const textarea = (label: string, value: string, change: (value: string) => void): HTMLElement => {
  const wrap = document.createElement("label"); wrap.className = "cewen-design-field"; wrap.textContent = label;
  const field = document.createElement("textarea"); field.value = value; field.setAttribute("aria-label", label); field.addEventListener("input", () => change(field.value)); wrap.append(field); return wrap;
};

/** 声明式条件只读取本次预演变量。 */
export function evaluateDialogueCondition(condition: DialogueCondition | undefined, variables: Variables): boolean {
  if (!condition) return true;
  const actual = variables[condition.variable]; const expected = condition.value;
  switch (condition.operator) {
    case "truthy": return Boolean(actual);
    case "falsy": return !actual;
    case "eq": return String(actual ?? "") === String(expected ?? "");
    case "ne": return String(actual ?? "") !== String(expected ?? "");
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
  }
}

/** 跳过条件、变量和跳转节点，限制循环步数以免预演卡住。 */
function resolveNode(block: DialogueBlock, start: string, variables: Variables): { node?: DialogueNode; error?: string } {
  let current = start;
  for (let step = 0; step < Math.max(16, block.nodes.length * 4); step++) {
    const node = block.nodes.find(item => item.id === current);
    if (!node) return { error: `找不到目标节点：${current}` };
    if (node.type === "line" || node.type === "end") return { node };
    if (node.type === "jump") current = node.target ?? "";
    if (node.type === "condition") current = (evaluateDialogueCondition(node.when, variables) ? node.then : node.else) ?? "";
    if (node.type === "variable") { if (node.variable) variables[node.variable] = node.value ?? ""; current = node.next ?? ""; }
    if (!current) return { error: `节点 ${node.id} 没有后续连接` };
  }
  return { error: "预演经过太多自动跳转，请检查循环" };
}

/** 正文里的阅读预览；操作仅更新 DOM 内的临时预演状态。 */
export function mountDialoguePreview(host: HTMLElement, block: DialogueBlock, options: { onEdit?: () => void; state?: DialoguePreviewState } = {}): () => void {
  const root = document.createElement("section"); root.className = "cewen-dialogue-preview"; root.setAttribute("aria-label", `对白预览：${block.title}`);
  host.append(root);
  const saved = options.state;
  let variables: Variables = saved?.variables ?? {}; let path: { nodeId: string; variables: Variables }[] = saved?.path ?? [];
  let cursor = saved?.cursor && block.nodes.some(node => node.id === saved.cursor) ? saved.cursor : block.start;
  let error = saved?.cursor && saved.cursor !== cursor ? "之前的预演位置已失效，已返回起点。" : "";
  let showPath = saved?.showPath ?? false;
  const render = () => {
    if (saved) { saved.cursor = cursor; saved.path = path; saved.variables = variables; saved.showPath = showPath; }
    root.replaceChildren(); const pendingError = error; error = ""; const heading = document.createElement("header"); heading.className = "cewen-design-heading";
    const title = document.createElement("strong"); title.textContent = block.title; heading.append(title);
    if (options.onEdit) heading.append(button("编辑对白", options.onEdit)); root.append(heading);
    const resolved = resolveNode(block, cursor, variables); error = resolved.error ?? pendingError; const node = resolved.node;
    const status = document.createElement("p"); status.className = "cewen-design-muted";
    status.textContent = error || (node?.type === "end" ? `对白结束${node.text ? ` · ${node.text}` : ""}` : `当前位置：${node?.speaker || "旁白"}`); root.append(status);
    if (node?.type === "line") {
      const line = document.createElement("p"); line.className = "cewen-dialogue-line"; line.textContent = node.text || "（未填写台词）"; root.append(line);
      const choices = document.createElement("div"); choices.className = "cewen-dialogue-choices";
      for (const choice of node.choices ?? []) {
        const available = evaluateDialogueCondition(choice.when, variables);
        const item = button(choice.text + (available ? "" : " · 条件未满足"), () => { if (!choice.to) { error = "这个选项尚未连接"; render(); return; } path.push({ nodeId: node.id, variables: structuredClone(variables) }); cursor = choice.to; render(); });
        item.disabled = !available; choices.append(item);
      }
      if (!node.choices?.length && node.next) choices.append(button("继续", () => { path.push({ nodeId: node.id, variables: structuredClone(variables) }); cursor = node.next!; render(); }));
      root.append(choices);
    }
    const actions = document.createElement("div"); actions.className = "cewen-design-actions";
    actions.append(button("上一步", () => { const previous = path.pop(); cursor = previous?.nodeId ?? block.start; variables = previous?.variables ?? {}; render(); }), button("重播", () => { variables = {}; path = []; cursor = block.start; render(); }), button(showPath ? "收起路径" : "显示路径", () => { showPath = !showPath; render(); }));
    actions.querySelector("button")!.toggleAttribute("disabled", !path.length); root.append(actions);
    if (showPath) { const list = document.createElement("p"); list.className = "cewen-design-muted"; list.textContent = "路径：" + [...path.map(item => item.nodeId), node?.id].filter(Boolean).map(value => block.nodes.find(item => item.id === value)?.speaker || value).join(" → "); root.append(list); }
  };
  render(); return () => root.remove();
}

/** 独立蓝图编辑器：所有更改先留在草稿，保存时才交给外层提交。 */
export function openDialogueEditor(block: DialogueBlock, options: { onSave: (block: DialogueBlock, positions: DialoguePositions) => void; positions?: DialoguePositions; onClose?: () => void }): () => void {
  let draft = clone(block); let positions: DialoguePositions = structuredClone(options.positions ?? {});
  draft.nodes.forEach((node, index) => { positions[node.id] ??= { x: 50 + (index % 3) * 260, y: 40 + Math.floor(index / 3) * 180 }; });
  let selected = new Set<string>(); let connecting: { from: string; port: string } | null = null; let scale = 1; let offset = { x: 0, y: 0 };
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("dialog"); overlay.className = "cewen-design-overlay"; overlay.setAttribute("aria-label", `编辑对白：${draft.title}`);
  const shell = document.createElement("div"); shell.className = "cewen-dialogue-editor"; overlay.append(shell); document.body.append(overlay); overlay.showModal();
  let closed = false;
  const close = () => { if (closed) return; closed = true; overlay.close(); overlay.remove(); if (priorFocus?.isConnected) priorFocus.focus(); else document.querySelector<HTMLElement>('dialog[open] .ProseMirror,dialog[open] button[data-action="save-document"]')?.focus(); options.onClose?.(); };
  overlay.addEventListener("cancel", event => { event.preventDefault(); close(); });
  const makeNode = (type: DialogueNode["type"]) => {
    const node: DialogueNode = { id: id(), type };
    if (type === "line") { node.speaker = "角色"; node.text = "新台词"; }
    if (type === "condition") node.when = { variable: "状态", operator: "truthy" };
    if (type === "variable") { node.variable = "状态"; node.value = true; }
    draft.nodes.push(node); positions[node.id] = { x: 90 + draft.nodes.length * 22, y: 80 + draft.nodes.length * 22 }; selected = new Set([node.id]); render();
  };
  const connect = (from: string, port: string, to: string) => {
    const node = draft.nodes.find(item => item.id === from); if (!node) return;
    if (port.startsWith("choice:")) { const choice = node.choices?.find(item => item.id === port.slice(7)); if (choice) choice.to = to; }
    else if (port === "then") node.then = to;
    else if (port === "else") node.else = to;
    else if (port === "target") node.target = to;
    else node.next = to;
    connecting = null; render();
  };
  const fieldTarget = (label: string, value: string | undefined, change: (value: string | undefined) => void) => {
    const wrap = document.createElement("label"); wrap.className = "cewen-design-field"; wrap.textContent = label;
    const select = document.createElement("select"); select.setAttribute("aria-label", label);
    for (const candidate of ["", ...draft.nodes.map(item => item.id)]) { const option = document.createElement("option"); option.value = candidate; option.textContent = candidate ? `${draft.nodes.find(item => item.id === candidate)?.speaker || draft.nodes.find(item => item.id === candidate)?.type} · ${candidate.slice(0, 8)}` : "未连接"; select.append(option); }
    select.value = value ?? ""; select.addEventListener("change", () => { change(select.value || undefined); render(); }); wrap.append(select); return wrap;
  };
  const conditionFields = (node: DialogueNode | DialogueChoice, panel: HTMLElement) => {
    panel.append(input("条件变量", node.when?.variable ?? "", value => { node.when = value ? { variable: value, operator: node.when?.operator ?? "truthy", value: node.when?.value } : undefined; }));
    const select = document.createElement("select"); select.setAttribute("aria-label", "条件操作符");
    for (const [value, label] of [["truthy", "为真"], ["falsy", "为假"], ["eq", "等于"], ["ne", "不等于"], ["gt", "大于"], ["gte", "大于等于"], ["lt", "小于"], ["lte", "小于等于"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); }
    select.value = node.when?.operator ?? "truthy"; select.addEventListener("change", () => { if (node.when) node.when.operator = select.value as DialogueCondition["operator"]; }); panel.append(select);
    panel.append(input("比较值", String(node.when?.value ?? ""), value => { if (node.when) node.when.value = value; }));
  };
  const render = () => {
    shell.replaceChildren();
    const top = document.createElement("header"); top.className = "cewen-design-toolbar";
    top.append(button("返回文档", close), input("对白标题", draft.title, value => { draft.title = value; }), button("预演", () => { const host = document.createElement("div"); host.className = "cewen-design-modal"; overlay.append(host); host.append(button("关闭预演", () => host.remove())); mountDialoguePreview(host, draft); }), button("保存对白", () => { options.onSave(clone(draft), structuredClone(positions)); close(); })); shell.append(top);
    const body = document.createElement("div"); body.className = "cewen-design-body"; shell.append(body);
    const tools = document.createElement("aside"); tools.className = "cewen-design-tools"; tools.setAttribute("aria-label", "节点工具"); body.append(tools);
    for (const [type, label] of [["line", "台词"], ["condition", "条件"], ["variable", "变量"], ["jump", "跳转"], ["end", "结束"]] as const) tools.append(button(`＋ ${label}`, () => makeNode(type)));
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "查找台词/角色"; search.setAttribute("aria-label", "查找对白节点");
    search.addEventListener("input", () => { const query = search.value.trim().toLowerCase(); if (!query) return; const found = draft.nodes.find(node => `${node.speaker ?? ""} ${node.text ?? ""} ${node.id}`.toLowerCase().includes(query)); if (found) { selected = new Set([found.id]); const card = world.querySelector(`[data-node-id="${found.id}"]`); card?.scrollIntoView({ block: "center", inline: "center" }); world.querySelectorAll(".cewen-dialogue-node").forEach(item => item.classList.toggle("is-selected", item === card)); renderProperty(); } }); tools.append(search);
    tools.append(button("复制选中", () => { const copies = draft.nodes.filter(node => selected.has(node.id)).map(node => { const copy = structuredClone(node); copy.id = id(); copy.next = undefined; copy.then = undefined; copy.else = undefined; copy.target = undefined; copy.choices?.forEach(choice => { choice.id = id(); choice.to = undefined; }); positions[copy.id] = { x: positions[node.id].x + 30, y: positions[node.id].y + 30 }; return copy; }); draft.nodes.push(...copies); selected = new Set(copies.map(node => node.id)); render(); }));
    tools.append(button("左对齐", () => { const x = Math.min(...[...selected].map(nodeId => positions[nodeId]?.x ?? Infinity)); if (Number.isFinite(x)) [...selected].forEach(nodeId => positions[nodeId].x = x); render(); }));
    tools.append(button("顶对齐", () => { const y = Math.min(...[...selected].map(nodeId => positions[nodeId]?.y ?? Infinity)); if (Number.isFinite(y)) [...selected].forEach(nodeId => positions[nodeId].y = y); render(); }));
    tools.append(button("放大", () => { scale = Math.min(2, scale * 1.2); render(); }), button("缩小", () => { scale = Math.max(.4, scale / 1.2); render(); }), button("适应视图", () => { scale = 1; offset = { x: 0, y: 0 }; render(); }));
    const stage = document.createElement("div"); stage.className = "cewen-dialogue-stage"; stage.setAttribute("aria-label", "对白节点编排区"); body.append(stage);
    const world = document.createElement("div"); world.className = "cewen-dialogue-world"; world.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`; stage.append(world);
    const wires = document.createElementNS("http://www.w3.org/2000/svg", "svg"); wires.setAttribute("class", "cewen-dialogue-wires"); world.append(wires);
    const wire = (from: DialogueNode, target: string | undefined, index = 0) => { if (!target || !positions[target]) return; const a = positions[from.id], b = positions[target]; const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", `M ${a.x + 210} ${a.y + 60 + index * 22} C ${a.x + 300} ${a.y + 60 + index * 22}, ${b.x - 80} ${b.y + 36}, ${b.x} ${b.y + 36}`); path.setAttribute("stroke", "currentColor"); path.setAttribute("fill", "none"); path.setAttribute("marker-end", "url(#cewen-arrow)"); wires.append(path); };
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); defs.innerHTML = '<marker id="cewen-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="currentColor"/></marker>'; wires.append(defs);
    draft.nodes.forEach(node => { wire(node, node.next); wire(node, node.then); wire(node, node.else, 1); wire(node, node.target); node.choices?.forEach((choice, index) => wire(node, choice.to, index)); });
    let pan: { x: number; y: number; ox: number; oy: number } | null = null;
    stage.addEventListener("pointerdown", event => { if (event.target !== stage && event.target !== world && event.target !== wires) return; if (!event.shiftKey) selected.clear(); pan = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; stage.setPointerCapture(event.pointerId); renderProperty(); });
    stage.addEventListener("pointermove", event => { if (!pan) return; offset = { x: pan.ox + event.clientX - pan.x, y: pan.oy + event.clientY - pan.y }; world.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`; });
    stage.addEventListener("pointerup", () => { pan = null; });
    stage.addEventListener("wheel", event => { event.preventDefault(); scale = Math.max(.4, Math.min(2, scale * (event.deltaY < 0 ? 1.1 : .9))); world.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`; }, { passive: false });
    for (const node of draft.nodes) {
      const card = document.createElement("article"); card.className = "cewen-dialogue-node" + (selected.has(node.id) ? " is-selected" : ""); card.style.left = `${positions[node.id].x}px`; card.style.top = `${positions[node.id].y}px`; card.setAttribute("aria-label", `${node.type} 节点 ${node.id}`);
      const title = document.createElement("div"); title.className = "cewen-dialogue-node-title"; title.textContent = `${node.type === "line" ? node.speaker || "台词" : node.type} · ${node.id.slice(0, 6)}`; card.append(title);
      let drag: { x: number; y: number; origins: DialoguePositions } | null = null;
      title.addEventListener("pointerdown", event => { event.stopPropagation(); if (!event.shiftKey && !selected.has(node.id)) selected = new Set([node.id]); else if (event.shiftKey) selected.add(node.id); drag = { x: event.clientX, y: event.clientY, origins: structuredClone(positions) }; title.setPointerCapture(event.pointerId); renderProperty(); card.classList.add("is-selected"); });
      title.addEventListener("pointermove", event => { if (!drag) return; for (const nodeId of selected) { positions[nodeId] = { x: drag.origins[nodeId].x + (event.clientX - drag.x) / scale, y: drag.origins[nodeId].y + (event.clientY - drag.y) / scale }; const target = world.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null; if (target) { target.style.left = `${positions[nodeId].x}px`; target.style.top = `${positions[nodeId].y}px`; } } });
      title.addEventListener("pointerup", () => { if (drag) { drag = null; render(); } });
      const summary = document.createElement("p"); summary.textContent = node.type === "line" ? node.text || "（空台词）" : node.type === "condition" ? `${node.when?.variable || "变量"} ${node.when?.operator || "?"}` : node.note || ""; card.append(summary);
      const addPort = (label: string, port: string, target: string | undefined) => card.append(button(`◉ ${label}${target ? " → " + target.slice(0, 6) : ""}`, () => { if (connecting) connect(connecting.from, connecting.port, node.id); else { connecting = { from: node.id, port }; render(); } }, "cewen-dialogue-port"));
      if (node.type === "line") { node.choices?.forEach(choice => addPort(choice.text, `choice:${choice.id}`, choice.to)); if (!node.choices?.length) addPort("继续", "next", node.next); }
      if (node.type === "condition") { addPort("满足", "then", node.then); addPort("不满足", "else", node.else); }
      if (node.type === "variable") addPort("继续", "next", node.next);
      if (node.type === "jump") addPort("跳至", "target", node.target);
      card.addEventListener("click", event => { if ((event.target as HTMLElement).closest("button")) return; if (connecting) { connect(connecting.from, connecting.port, node.id); return; } if (!event.shiftKey) selected = new Set([node.id]); else selected.add(node.id); renderProperty(); world.querySelectorAll(".cewen-dialogue-node").forEach(item => item.classList.toggle("is-selected", selected.has((item as HTMLElement).dataset.nodeId || ""))); });
      card.dataset.nodeId = node.id; world.append(card);
    }
    const panel = document.createElement("aside"); panel.className = "cewen-design-properties"; panel.setAttribute("aria-label", "节点属性"); body.append(panel);
    const renderProperty = () => {
      panel.replaceChildren(); const node = draft.nodes.find(item => selected.has(item.id));
      if (!node) { const hint = document.createElement("p"); hint.textContent = connecting ? "点击目标节点完成连接；再次点端口可改目标。" : "选择节点编辑属性。按 Shift 可多选，拖空白处平移。"; panel.append(hint); return; }
      const heading = document.createElement("h3"); heading.textContent = `节点属性 · ${node.type}`; panel.append(heading);
      panel.append(input("节点 ID", node.id, () => {})); (panel.lastElementChild?.querySelector("input") as HTMLInputElement).readOnly = true;
      if (node.type === "line") {
        panel.append(input("角色", node.speaker ?? "", value => { node.speaker = value; }), textarea("台词", node.text ?? "", value => { node.text = value; }));
        panel.append(button("添加玩家选项", () => { node.choices ??= []; node.choices.push({ id: id(), text: "新选项" }); render(); }));
        for (const choice of node.choices ?? []) {
          const group = document.createElement("div"); group.className = "cewen-design-subgroup";
          group.append(input("选项文字", choice.text, value => { choice.text = value; }), fieldTarget("跳转节点", choice.to, value => { choice.to = value; }), button("删除选项", () => { node.choices = node.choices?.filter(item => item.id !== choice.id); render(); })); conditionFields(choice, group); panel.append(group);
        }
        if (!node.choices?.length) panel.append(fieldTarget("后续节点", node.next, value => { node.next = value; }));
      }
      if (node.type === "condition") { conditionFields(node, panel); panel.append(fieldTarget("满足时", node.then, value => { node.then = value; }), fieldTarget("不满足时", node.else, value => { node.else = value; })); }
      if (node.type === "variable") { panel.append(input("变量名", node.variable ?? "", value => { node.variable = value; }), input("设置值", String(node.value ?? ""), value => { node.value = value; }), fieldTarget("后续节点", node.next, value => { node.next = value; })); }
      if (node.type === "jump") panel.append(fieldTarget("跳转目标", node.target, value => { node.target = value; }));
      panel.append(textarea("设计备注", node.note ?? "", value => { node.note = value; }), button("设为起点", () => { draft.start = node.id; render(); }), button("删除节点", () => { if (draft.nodes.length <= 1) return; draft.nodes = draft.nodes.filter(item => item.id !== node.id); delete positions[node.id]; selected.delete(node.id); if (draft.start === node.id) draft.start = draft.nodes[0].id; render(); }));
    };
    renderProperty();
  };
  render(); return close;
}
