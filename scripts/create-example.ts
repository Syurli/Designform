import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 生成完全虚构的示例资料。这里只写工具仓库中的示例模板，不扫描或读取真实游戏。
 * 模板首次生成后可直接维护 Markdown；运行本命令会明确重建 templates/example。
 */
const root = fileURLToPath(new URL('../templates/example/', import.meta.url));
const systems = [
  ['system-direction', '体验方向', '#EBC58D'], ['system-map', '地图与遭遇', '#7CBFFF'],
  ['system-resources', '资源取舍', '#ED9FAD'], ['system-time', '时间节奏', '#79D9C3'],
  ['system-journal', '记录与成长', '#B5A3F5'],
];
/** 每个条目只保留通用规则，数值与情境均为虚构教学材料。 */
const documents = [
  { id: 'gdd-example', path: 'docs/gdd/GDD.md', title: '纸上远行 · 游戏总纲', system: 'system-direction', summary: '这是一个完全虚构的短途探索示例，用来学习策问的文档、知识关系与问询。', rules: [
    ['experience', '轻量探索体验', '让玩家通过观察、选择路线和记录发现，完成一段有起点与终点的小旅程。'],
    ['loop', '观察、选择与记录', '核心循环为观察地点、选择行动、消耗资源或时间、记录新发现，再决定下一步路线。'],
    ['scope', '首版体验边界', '示例首版只描述一个小区域和一次完整旅程，不预设联机、商业化或复杂战斗系统。'],
  ] },
  { id: 'dd-map', path: 'docs/dd/DD-001_地图结构.md', title: '地图结构', system: 'system-map', summary: '用少量地点和明确的通路组织探索选择。', rules: [
    ['places', '地点与入口', '区域由入口、若干观察地点和终点组成，每个地点都有可阅读的环境说明。'],
    ['paths', '路线选择', '相邻地点之间可以有耗时不同的路线，玩家选择前能看到基本代价。'],
    ['visibility', '探索信息', '尚未到达的地点只展示轮廓，观察后才加入已知地点列表。'],
    ['rest', '休息地点', '休息地点允许整理记录和恢复状态，具体资源成本由资源文档维护。'],
  ] },
  { id: 'dd-resources', path: 'docs/dd/DD-002_资源取舍.md', title: '资源取舍', system: 'system-resources', summary: '资源规则为路线选择提供可理解的代价。', rules: [
    ['supply', '补给用途', '补给用于旅程中的准备和部分行动，界面始终展示当前数量。'],
    ['capacity', '携带上限', '玩家有明确的携带上限；上限只约束示例补给，不暗示任何复杂容器系统。'],
    ['rest-cost', '休息成本', '休息是否消耗补给仍待讨论，不能将推荐方案当作已经确定的规则。'],
    ['budget', '出发前的准备', '出发前展示预估时间和补给需求，帮助玩家理解不同路线。'],
  ] },
  { id: 'dd-time', path: 'docs/dd/DD-003_时间节奏.md', title: '时间节奏', system: 'system-time', summary: '通过离散行动推进时间，让代价在选择前可以理解。', rules: [
    ['step', '行动推进时间', '移动、观察和休息各自推进一段时间，暂不填入未经验证的具体数值。'],
    ['day', '白昼与夜晚', '时间阶段改变环境描述和部分地点可见信息，不直接代表失败。'],
    ['weather', '天气提示', '天气变化提前给出文字提示，具体影响可在后续问询中展开。'],
    ['timeline', '旅程时间记录', '旅程记录按行动顺序标记时间，帮助玩家回顾自己的选择。'],
  ] },
  { id: 'dd-encounters', path: 'docs/dd/DD-004_环境遭遇.md', title: '环境遭遇', system: 'system-map', summary: '遭遇以观察、选择和结果反馈构成可读的小事件。', rules: [
    ['observe', '先观察再行动', '遭遇先提供可见线索，玩家可以选择进一步观察。'],
    ['choice', '有限选项', '每个遭遇提供少量有明确区别的行动，不用换一种措辞重复同一选择。'],
    ['result', '结果反馈', '行动结果说明获得的信息和付出的代价，未知后果保持未知。'],
    ['leave', '离开遭遇', '玩家可放弃继续交互并回到地点路线，放弃不自动产生额外惩罚。'],
  ] },
  { id: 'dd-journal', path: 'docs/dd/DD-005_发现记录.md', title: '发现记录', system: 'system-journal', summary: '记录已经发现的内容，并让回顾成为下一次选择的依据。', rules: [
    ['discovery', '发现条目', '首次理解一个地点或现象后，将可确认的信息写入旅程笔记。'],
    ['index', '分类检索', '笔记可按地点和主题浏览，同一发现不因为多个分类而复制。'],
    ['review', '旅程回顾', '旅程结束展示路线、耗时和主要发现，不自动给玩家贴上好坏评价。'],
    ['unlock', '后续探索线索', '部分发现提供新的探索线索，是否立即开放新地点仍由地图规则决定。'],
  ] },
];
/** 这些跨文档联系是本虚构示例明确写下的设计关系，不冒充真实资料推断。 */
const links: [string, string, string, string][] = [
  ['gdd-example/loop', 'dd-map/paths', '引用', '路线选择承载循环中的选择步骤。'],
  ['gdd-example/loop', 'dd-journal/discovery', '依赖', '循环需要可保存的发现反馈。'],
  ['gdd-example/experience', 'dd-encounters/observe', '关联', '观察体验由遭遇和地点共同表达。'],
  ['gdd-example/scope', 'dd-map/places', '约束', '示例先组织一个有限区域。'],
  ['dd-map/paths', 'dd-time/step', '依赖', '路线需要统一的时间消耗规则。'],
  ['dd-map/paths', 'dd-resources/budget', '关联', '路线预估与出发准备应保持一致。'],
  ['dd-map/visibility', 'dd-encounters/observe', '依赖', '观察后更新可见信息。'],
  ['dd-map/visibility', 'dd-journal/discovery', '关联', '可确认信息可形成发现记录。'],
  ['dd-map/rest', 'dd-resources/rest-cost', '依赖', '休息地点不重复定义资源成本。'],
  ['dd-map/rest', 'dd-time/step', '依赖', '休息使用同一时间推进规则。'],
  ['dd-map/places', 'dd-encounters/leave', '关联', '离开遭遇后回到地点。'],
  ['dd-resources/supply', 'dd-resources/capacity', '约束', '补给持有量受到上限约束。'],
  ['dd-resources/budget', 'dd-map/paths', '依赖', '准备信息读取当前路线代价。'],
  ['dd-resources/budget', 'dd-time/day', '引用', '准备时展示预计跨越的时间阶段。'],
  ['dd-resources/rest-cost', 'dd-time/step', '关联', '成本问询需要一并考虑休息耗时。'],
  ['dd-resources/capacity', 'gdd-example/scope', '引用', '携带规则服从首版简洁边界。'],
  ['dd-time/day', 'dd-map/visibility', '约束', '时间阶段影响部分可见描述。'],
  ['dd-time/weather', 'dd-map/paths', '关联', '路线可能需要说明天气信息。'],
  ['dd-time/timeline', 'dd-time/step', '依赖', '回顾记录读取行动时间。'],
  ['dd-time/timeline', 'dd-journal/review', '引用', '时间记录用于旅程回顾。'],
  ['dd-time/step', 'gdd-example/loop', '引用', '离散行动属于核心循环。'],
  ['dd-encounters/observe', 'dd-time/step', '依赖', '观察要说明消耗的时间。'],
  ['dd-encounters/choice', 'dd-encounters/observe', '依赖', '选择以前置线索为基础。'],
  ['dd-encounters/result', 'dd-journal/discovery', '关联', '确定结果可加入发现记录。'],
  ['dd-encounters/result', 'dd-resources/supply', '引用', '涉及补给时沿用资源定义。'],
  ['dd-encounters/leave', 'dd-map/paths', '关联', '退出后继续选择路线。'],
  ['dd-journal/discovery', 'dd-map/places', '引用', '发现记录保存对应地点。'],
  ['dd-journal/index', 'dd-journal/discovery', '依赖', '分类浏览引用同一发现条目。'],
  ['dd-journal/review', 'dd-time/timeline', '依赖', '回顾采用既有行动记录。'],
  ['dd-journal/unlock', 'dd-map/visibility', '约束', '新线索不自动揭露全部地图信息。'],
  ['dd-journal/unlock', 'gdd-example/experience', '关联', '线索为后续轻量探索提供方向。'],
];

await mkdir(root, { recursive: true });
/** 写入目标由脚本固定，不能由外部文本引导到模板目录之外。 */
async function write(relative: string, text: string) {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text, 'utf8');
}
await write('PROJECT.md', '---\nid: project-fictional-example\nname: 纸上远行 · 基础示例\nformat: 1\nexample: true\ndescription: 完全虚构的探索游戏，用于学习策问的文档与知识关系。\n---\n\n# 纸上远行 · 基础示例\n\n从 [游戏总纲](docs/gdd/GDD.md) 开始。本项目不代表任何真实游戏策划。\n');
await write('docs/README.md', await readFile(fileURLToPath(new URL('../docs/protocol/PROJECT_FORMAT.md', import.meta.url)), 'utf8'));
for (const document of documents) {
  const systemHeader = document.id === 'gdd-example' ? `systems:\n${systems.map(([id, title, color]) => `  - id: ${id}\n    title: ${title}\n    color: '${color}'`).join('\n')}\n` : '';
  let text = `---\nid: ${document.id}\ntype: ${document.id === 'gdd-example' ? 'gdd' : 'dd'}\nstatus: draft\nsystem: ${document.system}\n${systemHeader}---\n\n# ${document.title}\n\n${document.summary}\n`;
  for (const [anchor, title, body] of document.rules) {
    text += `\n<a id="${anchor}"></a>\n\n## ${title}\n\n${anchor === 'rest-cost' ? '设计状态：待确认\n\n' : ''}${body}\n`;
    const relations = links.filter(([source]) => source === `${document.id}/${anchor}`);
    if (relations.length) text += '\n### 关联设计\n\n| 关系 ID | 类型 | 目标身份 | 目标 | 依据 |\n|---|---|---|---|---|\n';
    for (const relation of relations) {
      const [, target, type, note] = relation, [docId, targetAnchor] = target.split('/');
      const targetDoc = documents.find(item => item.id === docId)!;
      const href = path.posix.relative(path.posix.dirname(document.path), targetDoc.path);
      const targetTitle = targetDoc.rules.find(([id]) => id === targetAnchor)![1];
      text += `| relation-${String(links.indexOf(relation) + 1).padStart(3, '0')} | ${type} | ${docId} / ${targetAnchor} | [${targetTitle}](${href}#${targetAnchor}) | ${note} |\n`;
    }
    if (anchor === 'rest-cost') text += '\n### 相关问题\n\n[Q-001 休息是否消耗补给](../questions/Q-001_休息成本.md)。\n';
  }
  if (document.id === 'gdd-example') text += `\n## 专项文档\n\n${documents.slice(1).map(item => `- [${item.title}](../dd/${path.posix.basename(item.path)})，文档身份：${item.id}。`).join('\n')}\n`;
  await write(document.path, text);
}
await write('docs/questions/INDEX.md', '# 问询索引\n\n## 第一轮：补齐休息边界\n\n- [Q-001 休息是否消耗补给](Q-001_休息成本.md) · 尚未回答。\n');
await write('docs/questions/Q-001_休息成本.md', `---
id: question-rest
type: question
status: open
system: system-resources
---

# Q-001：休息是否消耗补给？

休息同时关联时间与资源，需要明确两者如何共同影响路线选择。

## 可选方案

- A：消耗少量补给。推荐理由：让休息与探索使用同一资源约束；代价：需要控制管理负担。
- B：只消耗时间。收益：容易理解；代价：需另行明确时间压力。
- 自定义、暂缓、问题前提不成立。

## 用户原始回答

尚未回答。推荐方案不代表已经选择。

## 模型解释

尚未形成。

## 决定记录

尚未采纳。

## 文档落实

资源取舍、时间节奏：等待问题回答后判断是否修改。

## 关联设计

| 关系 ID | 类型 | 目标身份 | 目标 | 依据 |
|---|---|---|---|---|
| relation-032 | 关联 | dd-resources / rest-cost | [休息成本](../dd/DD-002_资源取舍.md#rest-cost) | 该规则仍待回答。 |
| relation-033 | 关联 | dd-time / step | [行动时间](../dd/DD-003_时间节奏.md#step) | 回答需要考虑时间代价。 |
`);
console.log(`已生成虚构示例：${root}`);
