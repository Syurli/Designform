# 策问 0.6 设计块公开协议

日期：2026-09-23。对白与色板是同一份正式 Markdown 文档中的内容，不另建对白或色板文件。外部 LLM 只需阅读本文及文档正文，即可新增或修改设计块。`docs/layouts/<文档ID>.json` 仅记录节点位置等排版，不存台词、颜色或第二份正文。

## 围栏格式

使用完整围栏及 YAML 字段；一个围栏对应一个设计块。语言名固定为 `cewen-dialogue` 或 `cewen-palette`。`id`、对白节点 `id`、选项 `id`、色标 `id` 均为稳定身份：修改文字、重排或改色时保留原 ID；只有真正新建对象才生成新 ID。删除后不要把旧 ID 赋给无关对象。字符串按 YAML 规则引用，避免冒号等字符造成歧义。

```cewen-dialogue
kind: dialogue
id: dlg-inn-arrival
title: 驿站初遇
start: n-greeter
nodes:
  - id: n-greeter
    type: line
    speaker: 守灯人
    text: 山路冷，先进来歇一会儿吧。
    choices:
      - id: c-rest
        text: 进驿站歇脚
        to: n-rest
      - id: c-road
        text: 继续赶路
        to: n-road
        when:
          variable: 已备火把
          operator: truthy
  - id: n-rest
    type: end
    text: 玩家进入驿站
  - id: n-road
    type: end
    text: 玩家继续前行
```

`kind` 可省略，建议保留以方便阅读。对白必需字段：块的 `id`、`title`、`start`、`nodes`；每个节点的 `id`、`type`。`start` 必须指向现存节点。`nodes` 列表顺序只是文本展示顺序，剧情顺序由显式连接决定；不要通过节点坐标或 YAML 顺序推断跳转。

| 节点 type | 用途 | 常用字段 |
| --- | --- | --- |
| `line` | 角色或旁白台词 | `speaker` 角色、`text` 台词、`choices` 玩家选项；没有选项时可用 `next` 后续节点 |
| `condition` | 条件分流 | `when` 判断、`then` 满足时、`else` 不满足时 |
| `variable` | 设置临时预演变量 | `variable` 变量名、`value` 值、`next` 后续节点 |
| `jump` | 显式跳转 | `target` 目标节点 ID |
| `end` | 结束 | `text` 可写结束说明 |

每个选项含稳定 `id`、显示 `text`，可有 `to` 目标节点 ID 和 `when` 可用条件。条件对象用 `variable`、`operator`、可选 `value`。`operator` 支持 `truthy`（为真）、`falsy`（为假）、`eq`（等于）、`ne`（不等于）、`gt`（大于）、`gte`（大于等于）、`lt`（小于）、`lte`（小于等于）。条件仅为数据，不运行 JavaScript、脚本或任意表达式。预演变量只用于本次预演，不会成为正式游戏规则执行器。`note` 可为任何节点附设计备注。无目标连接会在预演中报出位置，不自动猜测路径。

```cewen-palette
kind: palette
id: pal-inn-evening
title: 驿站黄昏
source:
  path: docs/assets/inn-evening.png
  hash: sha256:example
  region: [0, 0, 640, 420]
  algorithm: local-lab-kmeans-v1
colors:
  - id: col-amber
    hex: "#C18A54"
    role: 主色
    intent: 保留炉火带来的温度
    locked: false
    sourceShare: 31.2
  - id: col-blue
    hex: "#394A5C"
    role: 辅色
    intent: 表现室外寒意
```

色板必需字段：块的 `id`、`title`、`colors`；每色的 `id`、`hex`。`hex` 使用 `#RRGGBB`。`role` 是设计用途，例如主色、辅色、强调色、中性色或自定义；`intent` 是文字意图；`locked` 指编辑器锁定状态。空白色板允许 `colors: []`，不要求源图。`source.path` 是项目内附件路径，`hash` 可帮助识别原图变化，`region` 为原图采样区域的 `[x,y,width,height]`，`algorithm` 记录提色算法版本。

`sourceShare` 仅表示该色仍与一次原图提取候选完全相同的近似面积百分比。提取候选与正式设计色板是两组不同数据：提取不会自动采纳，点选取色也没有面积占比。人工修改色值后须删除该色的 `sourceShare`，不可将原面积冒充新颜色的面积。图片提色在本机 Canvas 完成；全透明像素忽略，半透明像素按 alpha 加权，输出 sRGB 色值。外部 LLM 不必、也不应臆造图片面积统计。

从本机选择图片时，编辑器先在本机解码，再由文档工作台保存为草稿附件。成功后将项目内 `docs/assets/` 路径及可计算的 SHA-256 写入 `source`；保存附件失败时禁止保存本次色板。再次打开色板可依据 `source.path` 读取原图并重新提取。重新提取只更新候选，不覆盖已采纳颜色，尤其不覆盖锁定色。原图候选的占比与手工设计色一直分别显示；手工改色后原图候选统计仍可查看，但该设计色不再携带原 `sourceShare`。

公开 Markdown 负责内容，编辑器回调负责将草稿交给统一文档保存与版本流程。色板不影响工作台分类色。统计时一个对白源节点、一个选项文字只计一次，不把预演路径或蓝图视图重复计入；YAML 标记、ID 和路径不算正文字符。

## 阅读与排版投影

已有 `<!-- cewen:block <ID> -->` 身份行及有效 `docs/layouts/<文档ID>.json` 时，阅读页按公开坐标、尺寸和层级展示同一份 Markdown 内容；没有公开排版时按 Markdown 阅读顺序连续展示。折叠标题和对白预演位置属于界面状态，不改正文或统计。公开视觉注释从 `docs/annotations/<文档ID>.ink.json` 读取，按稳定块 ID 贴回内容；阅读页只显示、不改写。历史版本只读。
