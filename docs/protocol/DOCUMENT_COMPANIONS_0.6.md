# 策问 0.6 公开伴随文件协议

一份正式设计文档的正文仍以 `docs/gdd/` 或 `docs/dd/` 下的 Markdown 为权威源。排版与项目共享视觉注释使用自动管理的伴随文件，不在项目目录中形成独立设计条目，也不复制正文。

## 路径与内容

| 路径 | 内容 | 快照字段 |
| --- | --- | --- |
| `docs/layouts/<文档ID>.json` | 块与对白节点的位置、尺寸和层级 | `companions[path].text` |
| `docs/annotations/<文档ID>.ink.json` | 可编辑的公开笔画、文字、箭头和贴图锚点 | `companions[path].text` |
| `docs/annotations/<文档ID>.md` | 项目共享的讨论与阅读说明 | 不进入知识目录 |

文件名中的文档 ID 必须与 JSON 内的 `documentId` 一致，采用 ASCII 字母、数字、下划线或短横线，首字符为字母或数字，最多 120 字符。JSON `format` 固定为 `1`。每份伴随 JSON 最多 2 MiB。格式不正确的外部文件产生诊断，不能被自动发布为版本。

布局文件示例：

```json
{"format":1,"documentId":"dd-station","blocks":{"intro":{"x":40,"y":80,"width":480,"section":"opening"}},"dialogues":{"dialogue-intro":{"line-1":{"x":80,"y":120}}}}
```

笔画文件示例：

```json
{"format":1,"documentId":"dd-station","items":[{"id":"note-1","kind":"text","anchor":{"blockId":"intro"},"x":12,"y":24,"width":180,"height":60,"color":"#D78B48","opacity":0.85,"text":"节奏待核对","createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-23T00:00:00.000Z"}]}
```

`ink.items` 允许 `stroke`、`text`、`image`、`arrow`。共同字段为身份、锚点、位置、尺寸、颜色、透明度和创建/更新时间；旋转、点列、文字、项目附件路径及已处理状态按需提供。图片资源路径只指向 `docs/assets/`。

## 提交与恢复

公开伴随文件作为 UTF-8 文本 `FileChange` 加入与正文和附件相同的 `CommitRequest.changes`，需带当前 `baseHash`；创建使用 `null`。它们参与指纹、冲突检查、事务日志、快照、撤销、历史阅读、项目复制及导出。历史版本只读；恢复通过新的提交计划创建修订。私人未提交伴随更改放在 `DocumentDraft.companions`，不会进入公开历史。

`ProjectSnapshot.companions` 按路径提供 `{text,hash}`，读取方通过 `parseLayoutCompanion` 或 `parseInkCompanion` 校验后使用。`parseKnowledge` 不把 JSON 或 `docs/annotations/` 下的讨论 Markdown 当作设计正文或知识节点。

项目复制和当前稿／历史导出包含这些公开文件；历史快照校验 UTF-8、格式和哈希。MCP 上下文包对所选文档带入相应 layout、ink 和公开注释 Markdown，并受 4 MiB 上限约束；私人 `.cewen/` 内容不在其中。外部扫描对 `docs/layouts/` 与 `docs/annotations/` 使用同一受控路径规则，不能把未获支持的 JSON 自动封为版本。

## 内容统计口径

`countDocumentContent(markdown,{ink?,annotationMarkdown?})` 统计可读正文的非空白字符，含标点、标题、表格、链接显示文字；不含 YAML 头部、Markdown 标记、代码、HTML、图片替代文字与资源路径。代码字符、注释文字与注释对象单列。`cewen-dialogue` 和 `cewen-palette` fenced YAML 按设计语义读取一次，分别统计对白节点/台词/选项与色板颜色，不把序列化字段重复计字。图片报告引用次数及去重资源数。项目汇总应使用已保存版本，编辑器选区和未保存草稿由界面明确标记。

## 文档块身份与画布

文档画布使用 Markdown 顶层块作为纸面内容单位，独立一行的 `<!-- cewen:block <块ID> -->` 标记紧邻对应块。旧文档初次进入排版时才生成块身份；普通阅读不会擅自改写文件。富文本编辑时隐藏标记，回写先按完全相同原文、再按规范化文本、最后在相邻同类型块范围内继承身份；新增块生成新 ID，删除块的身份随块移除。代码围栏里的同样文字不是块标记，不得移除。

标题构成可折叠的章节树，下级标题和内容归入上级章节。`layout.blocks[块ID]` 的坐标相对所属章节；首次排版按实际渲染高度建立自然顺序和合理间距。折叠只压缩可见纸面，不改变公开布局。拖块、改尺寸、对齐和层级只更新 JSON；“阅读前移 / 阅读后移”才调整 Markdown 块顺序。章节移动时包含全部下级块。正文编辑按块回写对应原始 Markdown 片段，公开布局不保存正文副本。

独立的 `<a id="…"></a>` 锚点保留在 Markdown 阅读顺序中，但画布不显示空卡；锚点绑定到下一张可见内容卡供阅读链接定位。画布自身撤销与重做按用户操作记录正文和布局的共同前态；取消指针拖动不产生修改。知识解析会忽略合法画布身份注释的语义节点，同时保留原始 AST 位置和规则关系 ID。

引用定义与独立 HTML 锚点属于结构元信息，画布首次补块身份及富文本回写时不会为它们新增块标记。身份注释仅在 Markdown AST 顶层独立 HTML 节点识别；代码围栏、普通 HTML 内容中的同形文字保留原样。
