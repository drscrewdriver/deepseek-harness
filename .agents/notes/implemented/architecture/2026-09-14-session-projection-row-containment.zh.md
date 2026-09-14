# Agent Note: 投影的「行」与「列」各自降级

Status: implemented

[English](2026-09-14-session-projection-row-containment.md) | 中文

## Problem

会话投影的状态与 wire 值经由四条通路离开宿主：持久化检查点记录（冷读与列表提示）、转发的宿主事件 `api-session/added`（在线客户端），以及 Session Controller 的两条 Remote stream 项——控制流 baseline 与其变更帧、`session/follow` 快照的 projections 块。四条通路对非无损 JSON 的值（值为 `undefined` 的键、`Map`、`Date`、非有限数）都会拒绝或腐化，且失败方式各不相同：检查点写入抛错——由于写入是 fail-soft，该会话的**每一行**都滞留在上一个切点；转发的宿主事件抛错，客户端因此永远收不到该会话的列表条目；而 stream 项则是**静默腐化**——stream 项唯一的序列化是 `JSON.stringify`，全程没有 JSON 校验，`Map` 会变成 `{}`。于是某个插件的一个字段就抹掉了会话可用性——`session/fork` 回滚、重连后列表条目消失、正文仍能通过另一条路径读到——而同一输入的第二个类别只是把展示内容弄脏。

这四条通路都预设：注册表经由单元的 `viewSchema` 看过的值就是 JSON 安全的。该预设不成立：`viewSchema` 是 Zod 校验，它接受 `Map`、`Date`、以及含 `undefined` 值的对象；而 `SessionProjectionValues` 类型虽然声明了 JSON 安全的值，却无法对**本编译面之外**贡献的值施加约束。

缺陷在生产方，但爆炸半径原本由平台承担：投影单元是**开放集合**，而折叠捷径不是可以拖垮权威路径的权威数据。

## Decision

不被无损 JSON 接受的投影**行**或**列**，各自在其自身粒度上降级，绝不允许拖垮或污染本应承载它的通路。

- `SessionProjectionCache.put()` 逐行 detach 与校验；不可无损序列化的行被**省略**，并以一条 warn 指出 key 与会话 id，其余行仍在同一水位落盘。
- `losslessProjectionValues()` 是**所有 wire 通路**共用的列级规则：保留 `isJsonValue` 接受的列，并把每一个被丢弃的 key 上报给调用方，由调用方连同 key、会话 id 与自己所在的通路一起 warn。`ApiSessionList.projectionsFor()`、`SessionControlController.projectionBaseline()` 与 `session/follow` 的投影块都经由它取值。
- `SessionControlController` 在广播前丢弃取值非无损 JSON 的变更帧：客户端无法正确接收的帧，绝不作为被污染的帧发出去。
- 各通路的 `asOfSeq` 仍是注册表的切点，因此省略只可能把水位说得更陈旧；`isJsonValue` 保持既有严格度。任何通路都不做业务字段的归一化或重新解释，改变的只是**承载方式**。

## Alternatives considered

**在通路上把不合格值归一化。** 否决：传输层不重新解释业务字段；静默剥离会把生产方缺陷藏起来，而不是定位它。

**保持整条失败，改由生产方修复。** 否决：生产方是开放且无界的集合，而一个字段的代价是会话级不可用。生产方的正确性仍是独立义务。

**默认大声失败（放弃整条记录、抛出硬错误）。** 否决：投影缓存本身是派生的折叠捷径，其既定契约是"陈旧或不可读只意味着更长的尾部重放，绝不意味着一个错误的值"；让派生的行把展示单元格升级成故障，与其契约相悖。

**只收敛会抛错的两条通路（记录与转发事件）。** 否决：同一输入同样会进入两条 stream 通路，而且后果更糟——`JSON.stringify` 会发布一个结构合法、语义错误的值，且任何地方都没有告警，客户端看到的是一个"永远为空的列"，而不是"缺失的列"。

**提升 `stateVersion` 或迁移该行。** 否决：非 JSON 的值无法被迁移成 JSON，该行的问题是生产方的，而不是 schema 演进问题。

## Consequences

产出非 JSON 状态或 wire 值的单元，此后只损失自己的那一行/列：会话照常列出、fork 与写检查点，该 key 在生产者被修正前持续重折（或该列在列表与 stream 帧中持续缺席）。每次省略都会按通路带 key 与会话 id 报告一次——warn 才是定位信号，因此运维侧必须看日志，而不是期待平台拒绝；若需要显式的 strict 或计数面，属于生产方或后续平台策略的事。被省略的行会把 `restoreFloor` 拉到其最小值 0，因此下一次冷读需要**从日志起点重读**：被省略的 key 从 init 重折，而其余 key 仍以其缓存行作为种子，这使长期出错的单元对长会话构成冷读延迟成本。底层的生产方缺陷及其修复，仍归该单元的作者。
