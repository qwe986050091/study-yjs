# Yjs 深度中文注释索引

> 仓库：`d:\code\opensource\yjs`（上游 `yjs/yjs`，当前 `main` = `52396473`，包版本 `@y/y@14.0.0-rc.29`）
> 口径：注释密度按 `DENSITY-CALIBER v1`（X = 注释行 / 代码行；Y = 非空注释行 / 代码行）。
> 本文件只记录「本轮中文注释」的范围、顺序与状态；不修改上游英文注释。

## 0. 本轮注释目标

让读者只靠源码里的中文注释，就能按下面这条核心链路读完：

1. 文档模型：`Doc` / `StructStore` / `Transaction` / `Item` / 类型系统 `YNode`
2. 并发冲突解决：`Item.integrate` 里的 YATA 冲突消解
3. 二进制编解码：update 的编码格式与 `encoding.js` / `updates.js` / `UpdateEncoder(V1/V2)` / `UpdateDecoder(V1/V2)`
4. 同步协议：`sync protocol` 与 `awareness`（`@y/protocols` 源码副本，见 `docs/annotation/y-protocols/`）

**硬规则（针对已知坑）**：任何「谁在用它 / 在哪被调用」的中文断言，必须先 `grep` 到调用点再写；查不到调用点就不写，或明确标注「当前源码内未发现调用点」。本索引 §4 记录已经核对过的调用关系。

## 1. 阅读顺序与状态

状态：`待注释` / `进行中` / `已完成`。每完成 3 个文件回写一次本表。

| 序 | 文件 | 行数（基线） | 在链路中的角色 | 状态 |
|---:|---|---:|---|---|
| 1 | `src/utils/Doc.js` | 255 | 文档根对象：clientID、`share`、`store`、子文档、事务入口 | 已完成 |
| 2 | `src/utils/StructStore.js` | 151 | 按 client 分桶、按 clock 排序的 struct 仓库 | 已完成 |
| 3 | `src/utils/Transaction.js` | 446 | 事务对象、`transact()`、提交后的清理/事件/增量 update | 已完成 |
| 4 | `src/utils/transaction-helpers.js` | 413 | 二分查找、切分、合并、GC、格式清理等底层操作 | 已完成 |
| 5 | `src/structs/AbstractStruct.js` | 64 | struct 抽象基类（id + length） | 已完成 |
| 6 | `src/structs/GC.js` | 75 | 已回收 struct：只保留长度 | 已完成 |
| 7 | `src/structs/Skip.js` | 72 | 尚未收到的 clock 空洞占位 | 已完成 |
| 8 | `src/structs/Item.js` | 1517 | **YATA 核心**：`Item` 与全部 `Content*` | 已完成 |
| 9 | `src/ynode.js` | 2875 | 统一类型系统：`YNode`、列表/映射操作、`toDelta`、schema | 已完成 |
| 10 | `src/utils/ids.js` | 1752 | `IdSet` / `IdMap`（删除集、内容 id、归因区间） | 已完成 |
| 11 | `src/utils/encoding.js` | 697 | `applyUpdate` / `encodeStateAsUpdate` / 集成调度 | 已完成 |
| 12 | `src/utils/updates.js` | 576 | update 读、合并、差集、格式转换 | 已完成 |
| 13 | `src/utils/UpdateEncoder.js` | 323 | V1/V2 编码器 | 已完成 |
| 14 | `src/utils/UpdateDecoder.js` | 284 | V1/V2 解码器 | 已完成 |
| 15 | `src/utils/BlockSet.js` | 275 | 解码后的按 client 分块容器（集成前） | 已完成 |
| 16 | `src/utils/encoding-helpers.js` | 110 | struct 写入的事务增量编码 | 已完成 |
| 17 | `src/utils/ID.js` | 87 | `ID(client, clock)` 与比较 | 已完成 |
| 18 | `src/utils/RelativePosition.js` | 344 | 相对位置（光标）跨端定位 | 已完成 |
| 19 | `src/utils/Snapshot.js` | 198 | 快照 = state vector + delete set | 已完成 |
| 20 | `src/utils/YEvent.js` | 194 | 观察者事件与 delta 计算 | 已完成 |
| 21 | `src/utils/UndoManager.js` | 545 | 撤销/重做（分支主题） | 已完成 |
| 22 | `docs/annotation/y-protocols/sync.js` | 134 | 同步协议消息（0/1/2） | 已完成 |
| 23 | `docs/annotation/y-protocols/awareness.js` | 300 | 在线状态/光标广播 | 已完成 |

## 2. 基线密度（注释前，实测）

由 `node d:\code\_annot_baseline\yjs-density.mjs d:\code\opensource\yjs` 生成，基线快照在
`d:\code\_annot_baseline\YJS-deep-base`。

| 范围 | 文件 | 总行 | 代码行 | 注释行 | X | Y |
|---|---:|---:|---:|---:|---:|---:|
| `src/**/*.js` | 32 | 12,848 | 6,745 | 5,395 | 79.99% | 73.61% |

- 上游本身英文注释密度很高（X 80%），因此本轮「达标」不靠凑行数，靠**中文导读是否把链路讲通**。
- 收口时重新跑同一脚本，记录本轮新增注释行与 X/Y 变化。

## 3. 文件内导读约定

每个核心文件顶部加一段 `【中文导读】` 注释块，固定回答四件事：

1. 这个文件在链路里的位置（上游是谁、下游是谁）；
2. 关键数据结构与不变量；
3. 入口函数与建议阅读顺序；
4. 容易误读的点（与英文注释可能冲突时，以代码为准）。

函数级注释只在「算法分支 / 不变量 / 跨文件协议」处写，不写「本行赋值」式模板注释。

## 4. 调用关系核对记录

写「谁在用它」之前逐条核对，记录在此。

| 断言 | 核对方式 | 结果 |
|---|---|---|
| `Doc.get()` 创建的是统一 `YNode`，不再有 `YArray/YMap/YText` 子类 | `src/index.js` 导出 + `Doc.get` 实现 + 全仓 grep `new YArray` | 成立：`Doc.get` 内 `new YNode(name)`，`src/` 无 `YArray` 类 |
| `Item.integrate` 是唯一的 YATA 冲突消解入口 | grep `.integrate(` 的调用点 | 成立：本地插入（`typeListInsertGenericsAfter`、`insertContent`、`nodeMapSet`）与远端解码集成（`integrateStructs`）都走 `Item.integrate` |
| `StructStore.add` 的 Skip 替换分支只在「补收到缺失 struct」时触发 | `StructStore.add` 调用点 + `integrateStructs` 的 `offset < 0` 分支 | 成立：`integrateStructs` 先写 `Skip`，迟到 struct 到达后 `add` 用 `findIndexSS` 替换 |
| `applyUpdate` 会强制 `transaction.local = false` | `readUpdateV2` 第一行 | 成立 |

## 5. 批次记录

| 批次 | 内容 | 新增注释行（测） | 状态 |
|---|---|---:|---|
| 1 | 文档模型层：Doc / StructStore / Transaction / transaction-helpers / AbstractStruct / GC / Skip | +138 | 已完成 |
| 2 | YATA：Item.integrate + 9 个 Content* | +100 | 已完成 |
| 3 | 类型系统：ynode.js | +78 | 已完成 |
| 4 | IdSet/IdMap + 编解码：ids / encoding / updates / UpdateEncoder / UpdateDecoder / BlockSet / encoding-helpers / ID | +173 | 已完成 |
| 5 | 分支主题：RelativePosition / Snapshot / YEvent / UndoManager | +60 | 已完成 |
| 6 | 同步协议：y-protocols sync / awareness（源码副本，不计入 src 口径） | +56（整行，含 import 段后的注释块） | 已完成 |

> 批 1–5 的数值由 `yjs-baseline.json` 与 `yjs-after.json` 逐文件相减得到（测），不是估。
> 批 6 不在 `src/` 口径内，单独按源码副本行数差统计（测）。

## 6. 收口实测

同一脚本 `node d:\code\_annot_baseline\yjs-density.mjs d:\code\opensource\yjs`，范围 `src/**/*.js`：

| 时点 | 总行 | 代码行 | 注释行 | X | Y |
|---|---:|---:|---:|---:|---:|
| 注释前 | 12,848 | 6,745 | 5,395 | 79.99% | 73.61% |
| 注释后 | 13,415 | 6,745 | 5,944 | 88.12% | 81.19% |

- 新增整行注释 567 行（其中 549 行计入注释行），代码行数不变（6,745 -> 6,745）。
- `src/**/*.js` 中 X < 30% 的文件仅 2 个：`content-helper.js`（1 行空文件）与 `schemas.js`（3 行 schema 声明），均不在核心链路。
- 语法：23 个改动文件全部通过 `node --check`。

## 7. 同步协议源码副本说明

`docs/annotation/y-protocols/sync.js` 与 `awareness.js` 是 `@y/protocols@1.0.6-rc.1`
（commit `73b2ff7`）`src/` 下同名文件的原样副本，仅添加中文注释；LICENSE 一并保留。
这样 `study-yjs` 单仓即可读完整条「文档模型 -> YATA -> 编解码 -> 同步协议」链路，
同时不修改 yjs 上游仓库的目录结构。
