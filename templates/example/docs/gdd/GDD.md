---
id: gdd-example
type: gdd
status: draft
---

# 纸上远行 · 游戏总纲

这是一个完全虚构的短途探索示例，用来学习策问的文档、知识关系与问询。

<a id="experience"></a>

## 轻量探索体验

让玩家通过观察、选择路线和记录发现，完成一段有起点与终点的小旅程。[环境遭遇](../dd/DD-004_环境遭遇.md)提供可见线索，让玩家先理解环境，再决定行动。

<a id="loop"></a>

## 观察、选择与记录

玩家先观察地点，再从[地图结构](../dd/DD-001_地图结构.md)提供的路线中选择下一步。行动会消耗资源或时间；[发现记录](../dd/DD-005_发现记录.md)保存这次旅程获得的信息，帮助玩家作出下一次选择。

<a id="scope"></a>

## 首版体验边界

示例首版只描述一个小区域和一次完整旅程，不预设联机、商业化或复杂战斗系统。

## 专项文档

- [地图结构](../dd/DD-001_地图结构.md)。
- [资源取舍](../dd/DD-002_资源取舍.md)。
- [时间节奏](../dd/DD-003_时间节奏.md)。
- [环境遭遇](../dd/DD-004_环境遭遇.md)。
- [发现记录](../dd/DD-005_发现记录.md)。

### 关联索引

| 关系 ID | 来源身份 | 类型 | 目标身份 | 目标 | 依据 |
|---|---|---|---|---|---|
| relation-003 | gdd-example/experience | 关联 | dd-encounters / observe | [先观察再行动](../dd/DD-004_环境遭遇.md#observe) | 观察体验由遭遇和地点共同表达。 |
| relation-001 | gdd-example/loop | 引用 | dd-map / paths | [路线选择](../dd/DD-001_地图结构.md#paths) | 路线选择承载循环中的选择步骤。 |
| relation-002 | gdd-example/loop | 依赖 | dd-journal / discovery | [发现条目](../dd/DD-005_发现记录.md#discovery) | 循环需要可保存的发现反馈。 |
| relation-004 | gdd-example/scope | 约束 | dd-map / places | [地点与入口](../dd/DD-001_地图结构.md#places) | 示例先组织一个有限区域。 |
