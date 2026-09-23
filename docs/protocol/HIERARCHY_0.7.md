# 策问 0.7 分类与文档层级

项目总纲（`type: gdd`）是唯一根。旧总纲中的 `system`、`parent` 字段读取时不参与层级投影，原文不被自动改写。根下是顶层分类，分类可再包含子分类；专项 DD / 问题文档直接归入分类，也可归入另一份专项文档。总纲以下最多五层。文档章节仍属于原文档；`sectionSystems` 可为章节指定独立分类显示。

`PROJECT.md` 的 `systems` 数组保存分类身份、名称、颜色及可选 `parent`（父分类 ID）。同一父分类下的顺序取数组中的出现顺序。专项文档 YAML 的 `system` 保存主要分类，`parent` 可填写父文档 ID；父文档存在时，读取投影继承其主要分类。移动父文档时同批次更新全部后代的 `system`，避免磁盘元数据相互矛盾。分类与文档都不能成为自己的祖先，不能越过五层上限；不存在的父身份产生诊断。

`PROJECT.md` 的 `documentOrder` 继续使用分类 ID 为键保存该分类直属文档的顺序。子文档使用 `document:<父文档ID>` 为键。目录与图谱中的同级文档均按此顺序投影；缺少顺序的旧项目按标题排列。顺序不代表设计依赖或正文引用。改变父文档、分类或同级顺序时，只修改必要的 YAML 元数据与顺序索引；正文、别名、稳定身份和手工关系保留。

共享接口位于 `shared/project-hierarchy.ts`：`getRootDocumentId(data)` 取得根身份；`groupAncestors(data,id)` 与 `documentAncestors(data,id)` 返回从顶层到直接父项的链，均不包含总纲与自身；`effectiveDocumentParent(data,id)` 返回文档的直接父项；`moveHierarchy(snapshot,{kind,id,targetId,placement})` 产生供同一次提交使用的 `FileChange[]`。`placement` 为 `before`、`after` 或 `inside`。分类 `inside` 根总纲表示顶层；文档 `inside` 分类表示直属，`inside` 另一份专项文档表示子文档。历史快照只读，总纲不可移动。
