import YAML from "yaml";

/** 设计块属于正式 Markdown 正文；坐标只由外层公开布局记录。 */
export type DialogueCondition = { variable: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "truthy" | "falsy"; value?: string | number | boolean };
export type DialogueChoice = { id: string; text: string; to?: string; when?: DialogueCondition };
export type DialogueNode = {
  id: string;
  type: "line" | "condition" | "variable" | "jump" | "end";
  speaker?: string;
  text?: string;
  next?: string;
  choices?: DialogueChoice[];
  when?: DialogueCondition;
  then?: string;
  else?: string;
  variable?: string;
  value?: string | number | boolean;
  target?: string;
  note?: string;
};
export type DialogueBlock = { kind: "dialogue"; id: string; title: string; start: string; nodes: DialogueNode[] };
export type PaletteColor = { id: string; hex: string; role?: string; intent?: string; locked?: boolean; sourceShare?: number };
export type PaletteBlock = {
  kind: "palette";
  id: string;
  title: string;
  source?: { path?: string; hash?: string; region?: [number, number, number, number]; algorithm?: string };
  colors: PaletteColor[];
};
export type DesignBlock = DialogueBlock | PaletteBlock;
export type DialoguePositions = Record<string, { x: number; y: number }>;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空文字`);
  return value;
};
const identifier = (value: unknown, name: string): string => { const id = str(value, name); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)) throw new Error(`${name} 只能使用字母、数字、下划线和连字符`); return id; };
const optional = (value: unknown): string | undefined => value === undefined || value === null ? undefined : str(value, "可选文字");
const scalar = (value: unknown): string | number | boolean | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;

/** 条件是可读数据，不执行脚本或表达式。 */
export function parseDialogueCondition(value: unknown): DialogueCondition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!record(value)) throw new Error("条件必须是字段对象");
  const operator = str(value.operator, "条件操作符") as DialogueCondition["operator"];
  if (!["eq", "ne", "gt", "gte", "lt", "lte", "truthy", "falsy"].includes(operator)) throw new Error(`不支持条件操作符 ${operator}`);
  return { variable: str(value.variable, "条件变量"), operator, ...(scalar(value.value) !== undefined ? { value: scalar(value.value) } : {}) };
}

/** 解析 fenced code 的语言标记及 YAML 块体。未知语言返回 null。 */
export function parseDesignBlock(lang: string, body: string): DesignBlock | null {
  const language = lang.trim().toLowerCase();
  if (language !== "cewen-dialogue" && language !== "cewen-palette") return null;
  const raw: unknown = YAML.parse(body, { uniqueKeys: true });
  if (!record(raw)) throw new Error("设计块 YAML 必须是对象");
  const id = identifier(raw.id, "设计块 id");
  const title = str(raw.title, "设计块标题");
  if (language === "cewen-dialogue") {
    if (raw.kind !== undefined && raw.kind !== "dialogue") throw new Error("对白块 kind 应为 dialogue");
    if (!Array.isArray(raw.nodes)) throw new Error("对白 nodes 必须是数组");
    const ids = new Set<string>();
    const nodes: DialogueNode[] = raw.nodes.map((entry: unknown) => {
      if (!record(entry)) throw new Error("对白节点必须是对象");
      const nodeId = identifier(entry.id, "节点 id");
      if (ids.has(nodeId)) throw new Error(`重复节点 id ${nodeId}`);
      ids.add(nodeId);
      const type = str(entry.type, "节点 type") as DialogueNode["type"];
      if (!["line", "condition", "variable", "jump", "end"].includes(type)) throw new Error(`不支持节点类型 ${type}`);
      let choices: DialogueChoice[] | undefined;
      if (entry.choices !== undefined) {
        if (!Array.isArray(entry.choices)) throw new Error("choices 必须是数组");
        const choiceIds = new Set<string>();
        choices = entry.choices.map((item: unknown) => {
          if (!record(item)) throw new Error("选项必须是对象");
          const choiceId = identifier(item.id, "选项 id");
          if (choiceIds.has(choiceId)) throw new Error(`重复选项 id ${choiceId}`);
          choiceIds.add(choiceId);
          return { id: choiceId, text: str(item.text, "选项文字"), ...(optional(item.to) ? { to: optional(item.to) } : {}), ...(parseDialogueCondition(item.when) ? { when: parseDialogueCondition(item.when) } : {}) };
        });
      }
      return {
        id: nodeId, type,
        ...(optional(entry.speaker) ? { speaker: optional(entry.speaker) } : {}),
        ...(optional(entry.text) ? { text: optional(entry.text) } : {}),
        ...(optional(entry.next) ? { next: optional(entry.next) } : {}),
        ...(choices ? { choices } : {}),
        ...(parseDialogueCondition(entry.when) ? { when: parseDialogueCondition(entry.when) } : {}),
        ...(optional(entry.then) ? { then: optional(entry.then) } : {}),
        ...(optional(entry.else) ? { else: optional(entry.else) } : {}),
        ...(optional(entry.variable) ? { variable: optional(entry.variable) } : {}),
        ...(scalar(entry.value) !== undefined ? { value: scalar(entry.value) } : {}),
        ...(optional(entry.target) ? { target: optional(entry.target) } : {}),
        ...(optional(entry.note) ? { note: optional(entry.note) } : {}),
      };
    });
    const start = identifier(raw.start, "起点 start");
    if (!ids.has(start)) throw new Error(`起点 ${start} 不存在`);
    return { kind: "dialogue", id, title, start, nodes };
  }
  if (raw.kind !== undefined && raw.kind !== "palette") throw new Error("色板块 kind 应为 palette");
  if (!Array.isArray(raw.colors)) throw new Error("色板 colors 必须是数组");
  const ids = new Set<string>();
  const colors: PaletteColor[] = raw.colors.map((entry: unknown) => {
    if (!record(entry)) throw new Error("颜色必须是对象");
    const colorId = identifier(entry.id, "颜色 id");
    if (ids.has(colorId)) throw new Error(`重复颜色 id ${colorId}`);
    ids.add(colorId);
    const hex = str(entry.hex, "颜色 hex").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) throw new Error(`颜色 ${colorId} 必须使用 #RRGGBB`);
    const sourceShare = entry.sourceShare;
    if (sourceShare !== undefined && (typeof sourceShare !== "number" || sourceShare < 0 || sourceShare > 100)) throw new Error("原图占比必须介于 0 到 100");
    return { id: colorId, hex, ...(optional(entry.role) ? { role: optional(entry.role) } : {}), ...(optional(entry.intent) ? { intent: optional(entry.intent) } : {}), ...(typeof entry.locked === "boolean" ? { locked: entry.locked } : {}), ...(typeof sourceShare === "number" ? { sourceShare } : {}) };
  });
  let source: PaletteBlock["source"];
  if (record(raw.source)) {
    const region = raw.source.region;
    source = {
      ...(optional(raw.source.path) ? { path: optional(raw.source.path) } : {}),
      ...(optional(raw.source.hash) ? { hash: optional(raw.source.hash) } : {}),
      ...(Array.isArray(region) && region.length === 4 && region.every(item => typeof item === "number") ? { region: region as [number, number, number, number] } : {}),
      ...(optional(raw.source.algorithm) ? { algorithm: optional(raw.source.algorithm) } : {}),
    };
  }
  return { kind: "palette", id, title, ...(source ? { source } : {}), colors };
}

/** 序列化为 fenced 块体；外围 Markdown 围栏由正文编辑器维护。 */
export function serializeDesignBlock(block: DesignBlock): string {
  return YAML.stringify(block, { lineWidth: 0 });
}
