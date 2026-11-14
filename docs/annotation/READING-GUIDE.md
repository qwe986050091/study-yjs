# Yjs（v14 RC）核心链路阅读指南

> 仓库：`d:\code\opensource\yjs`
> 上游：`yjs/yjs`，`main` @ `52396473`，包名 `@y/y@14.0.0-rc.29`
> 配套：`docs/annotation/INDEX.md`（注释范围与实测密度）、`docs/annotation/y-protocols/`（同步协议源码副本）
> 所有「谁在用它」的判断都在本仓 grep 过调用点；未找到调用点的会明说。

---

## 0. 先读这一节：v14 和网上大多数 Yjs 文章不一样

v14 是一次大重构。读之前先校准三个事实，否则会被旧资料带偏：

1. **没有 `YArray` / `YMap` / `YText` 子类了。** 全仓只有一个统一类型 `YNode`（`src/ynode.js`），
   列表、映射、文本共用同一套 `Item` 链表；形状由 `name` / delta schema 决定。
   `src/index.js` 里的导出是 `YNode as Node`，没有 `YArray` 等导出。
2. **`INTERNALS.md` 已部分过期。** 它第 37–42 行仍在讲 `src/types/AbstractType.js` 和 `YText` 子类，
   这些文件/类在当前 `src/` 中不存在。把 `INTERNALS.md` 当历史背景，不要当目录。
3. **同步协议与 awareness 不在本仓。** 它们在 `@y/protocols` 包（`yjs/y-protocols`）。
   本仓 `tests/` 只 import 它。为了单仓可读，`docs/annotation/y-protocols/` 放了
   `@y/protocols@1.0.6-rc.1`（commit `73b2ff7`）的 `sync.js` / `awareness.js` 源码副本，并加了中文注释。

---

## 1. 前置知识（够用即可，不必先学完）

| 主题 | 需要知道的最小集 | 在代码里对应什么 |
|---|---|---|
| CRDT / 最终一致 | 副本各自修改、乱序到达、不靠中心节点也能收敛 | 整个 `Item.integrate` 的存在理由 |
| 逻辑时钟 | `(client, clock)` 唯一标识一段历史；clock 不按时间，按 struct 长度递增 | `src/utils/ID.js`、`StructStore.clients` |
| 双向链表 | 每个 Item 有 `left` / `right`，文档顺序靠它 | `Item.left/right`、`YNode._start` |
| 区间集合 | `[clock, clock+len)` 左闭右开；可排序合并 | `src/utils/ids.js` 的 `IdRange/IdRanges/IdSet` |
| UTF-16 | JS 字符串下标是 UTF-16 code unit；表情占两个 | `ContentString.splice` 的代理对处理 |
| varint / RLE / 差分 | 小整数变长、重复值压缩、相对上一个值编码 | `UpdateEncoderV2` / `UpdateDecoderV2` |

不需要先会：YATA 论文、OT、Yjs v13 的 `DeleteSet` API。代码里的中文注释会在用到时补定义。

---

## 2. 从哪个文件开始读（以及为什么不从最容易想到的入口开始）

### 最容易想到的入口，以及为什么不适合先读

- **`src/index.js`**：它只是导出清单（外加一个「重复 import 会破坏 instanceof」的告警）。
  读它能知道有哪些 API，但读不出任何链路。
- **`doc.get('text')` / `new Y.Node()`**：这是用户 API。它直接返回统一 `YNode`，
  把 `Item`、`StructStore`、clock 全藏在后面；先读它会产生「类型里直接存内容」的错觉。
- **`src/structs/Item.js` 直接啃 `integrate`**：算法本身只有 80 行，但没有坐标系统
  （ID/clock/Skip）和事务模型（insertSet/deleteSet）打底，会看成「一堆 if」。

### 建议的第一站：`src/utils/ID.js` → `src/utils/StructStore.js`

先花 20 分钟建立坐标系：

1. `src/utils/ID.js`（87 行）：`ID = (client, clock)`；`compareIDs` 是值比较。
   记住：ID 不是对象引用，同 client/clock 即相等。
2. `src/utils/StructStore.js`（151 行）：`clients: Map<client, Array<Item|GC|Skip>>`，
   每个数组按 clock 升序、无缝（空洞用 Skip）。重点读 `add()` 里 Skip 被真实 struct
   替换的分支，以及 `getStateVector()` 为什么遇到 Skip 要把 clock 截断到空洞起点。
3. 顺手读 `src/structs/AbstractStruct.js` / `GC.js` / `Skip.js`（各 60–75 行）。
   三者共同回答：一个 struct 最少要有什么（id + length）；GC 和 Skip 分别占什么坑。

**这一段结束的标志**：你能解释「state vector 说 client A 到 clock 100，是否等于 A 的 0–99 都收到了？」
（答案：不一定是，若有 Skip，state vector 会停在空洞起点。）

---

## 3. 分段路线

下面六段按依赖顺序排。每段给出「读到哪算结束」和「这段能获得什么」。建议每段读完
回到本指南做一次自问，答不上再回读对应文件顶部的中文导读。

### 段 A：一次本地写入如何变成 struct

**读**：`src/utils/Doc.js`（先只读字段与 `transact`）→ `src/utils/Transaction.js` →
`src/utils/transaction-helpers.js` → `src/ynode.js` 的 `typeListInsertGenericsAfter` /
`nodeMapSet` / `insertContent`。

**到哪里算结束**：跟完 `doc.transact(() => node.insert(0, ['a']))` 的调用链，直到
`new Item(...).integrate(transaction, 0)` 把 struct 写进 `store`，事务提交时
`writeUpdateMessageFromTransaction` 生成 update。

**能获得**：

- 事务的嵌套规则：只有最外层创建 Transaction；`transact` 的 `initialCall` 控制收尾。
- 三个集合的分工：`insertSet`（要广播的新 struct）、`deleteSet`（删除区间）、
  `cleanUps`（格式清理顺带删的区间，是 deleteSet 子集）。
- 为什么删除是「打标记 + 记 deleteSet」，不是从链表摘掉。
- `Item` 的两套位置：`left/right`（文档顺序）与 `StructStore` 数组（clock 顺序）。

**常见误读**：`transaction.changed` 只记直接变更；`changedParentTypes` 才是冒泡给
`observeDeep` 的。前者用于浅层观察者，后者用于深层/delta 通道。

### 段 B：YATA 冲突解决

**读**：`src/structs/Item.js` 的 `integrate`（重点 `while (o !== null && o !== this.right)` 循环）
→ `src/utils/encoding.js` 的 `getMissing` 与 `integrateStructs`。

**到哪里算结束**：能拿纸笔模拟两个 client 在同一位置并发插入，说明为什么两端最终顺序一致；
能解释 `conflictingItems` 与 `itemsBeforeOrigin` 的区别，以及 case 1 / case 2 各在做什么。

**能获得**：

- 每个 Item 的两个锚点：`origin`（插入时看到的左邻居）、`rightOrigin`（右邻居）。
- 冲突判定：同 `origin` 是直接冲突（case 1，用 client id 定序）；
  `o.origin` 落在已扫描区域是间接冲突（case 2，看它依赖的项是否已落定）。
- 快路径：`left.right === right` 时无需扫描——这是绝大多数本地顺序插入的情况。
- 远端集成不是「按到达顺序插」：`integrateStructs` 用依赖栈回溯，缺依赖先写 Skip，
  剩余部分编码成 `restStructs` 存进 `pendingStructs`，等后续 update 重试。
- `getMissing` 会把远端 ID 解析成本地 Item；一旦解析，原始字段就不再可读。

**常见误读**：`_map[key]` 指向该 key 最右（最新）的 Item，旧值仍留在链表里，
只是被 `delete` 打标记。所以「map 覆盖」在结构上是追加，不是替换。

### 段 C：类型系统与用户 API

**读**：`src/ynode.js` 的 `YNode` 字段、`_integrate`、`insert/push/delete/get`、
`setAttr/getAttr`、`findMarker`、`toDelta`、`applyDelta`。

**到哪里算结束**：能把 `node.insert(index, ...)`、`node.setAttr(key, v)`、
`node.toDelta()` 分别映射到 Item 操作；能解释 search marker 的作用和失效条件。

**能获得**：

- 统一类型模型：列表用 `_start` + `left/right`；map 用 `_map`；`_length` 只统计
  `parentSub === null && countable && !deleted` 的子项。
- 位置缓存：`_searchMarker` 最多 80 个，`findMarker` 从最近 marker 局部走；
  非本地事务（`!transaction.local`）会清空 marker，避免远端变更后缓存失真。
- `toDelta` 是只读投影，支持「全量」与「只投影本事务变更」两种模式；
  `applyDelta` 是它的逆操作。
- 连续标量会被压进同一个 `ContentAny` / `ContentString`，减少 Item 数量。

**常见误读**：`_length` 不含 map key，也不含 `ContentFormat`（格式标记零宽、不可计数）。
文本的格式是链表里的零宽 Item，不是字符属性。

### 段 D：二进制编解码

**读**：`src/utils/UpdateEncoder.js` / `UpdateDecoder.js`（先看 V1，再看 V2 的列式布局）
→ `src/utils/BlockSet.js` 的 `readBlockSet` / `writeBlockSet` / `insertInto`
→ `src/utils/updates.js` 的 `applyUpdateV2`、`encodeStateAsUpdateV2`、`mergeUpdatesV2`、
`diffUpdateV2` → `src/utils/encoding.js` 的 `readUpdateV2`、`writeStateAsUpdate`、
`state vector` 读写。

**到哪里算结束**：能画出 V2 update 的字节布局：
`client 数个 -> 每 client 的块（clock + info + 各列字段）-> 删除集`；
能解释 `diffUpdate` 如何只写目标端缺的 clock、`mergeUpdates` 为什么不是简单拼接。

**能获得**：

- info 低 5 位是 content ref（0 GC、1 Deleted、2 JSON、3 Binary、4 String、5 Embed、
  6 Format、7 Type、10 Skip），高位是 origin/rightOrigin/parentSub 的存在标志。
- V2 的「列式 + RLE + 差分」：client、leftClock、rightClock、info、parentInfo、
  typeRef、len 各一列；IdSet 的 clock/len 相对 `dsCurrVal` 差分，每个 client 前重置。
- 解码与集成是两件事：`readBlockSet` 只解出块（允许乱序/有洞），
  `integrateStructs` 才按依赖集成。
- 删除集可以晚于 struct 到：`readAndApplyDeleteSet` 把未命中的区间存进 `pendingDs`，
  遇到 Skip 也视为未应用。

**常见误读**：`decodeUpdate` 返回的 Item 依赖仍是远端 ID，不能直接当本地 Item 用。
要可读状态必须 `applyUpdate`。

### 段 E：同步协议

**读**：`docs/annotation/y-protocols/sync.js` → `awareness.js`；对照本仓
`src/utils/encoding.js` 的 `encodeStateVector / encodeStateAsUpdate / applyUpdate`。

**到哪里算结束**：能写出客户端-服务端三步握手，说明每条消息带什么；
能解释 awareness 的 clock 覆盖规则和 30s 超时。

**能获得**：

- SyncStep1 只带 state vector；Step2 带「对端缺的 struct + 完整删除集」；Update 是日常增量。
- 消息本身不含房间名，路由是 provider 的职责。
- awareness 不进 CRDT：每个 client 只改自己的 state，用递增 clock 覆盖；
  对端只接受更大 clock，相同 clock 只允许 `null` 覆盖已有状态。
- 远端不能删除「我」的本地状态：收到这种消息时本地 clock+1 并保留，下次广播纠正对端。

### 段 F（可选）：把链路串起来跑一遍

**读**：`tests/` 里挑 3 个用例：`doc.tests.js` 的并发合并、`updates.tests.js` 的
merge/diff、`relativePositions.tests.js` 的光标漂移。

**能获得**：把前面五段的行为预期落到可执行断言上。测试也是「当前 API 真实用法」的
最可靠来源（本指南里 `doc.get('array')`、`new Y.Node('a')` 等都来自测试）。

---

## 4. 分支主题从哪跳

主链路读完后，按需要跳：

| 主题 | 入口 | 什么时候需要读 |
|---|---|---|
| 撤销/重做 | `src/utils/UndoManager.js` | 需要 undo/redo、协同编辑历史 |
| 光标/评论锚点 | `src/utils/RelativePosition.js` | 需要跨端稳定的位置（评论、选区） |
| 历史快照 | `src/utils/Snapshot.js` | 需要「某个时刻的文档视图」、版本对比 |
| 变更事件/delta | `src/utils/YEvent.js`、`ynode.toDelta` | 需要做 diff renderer、增量渲染 |
| 子文档 | `src/structs/Item.js` 的 `ContentDoc`、`Doc.load/destroy` | 需要嵌套文档、按需加载 |
| 归因/建议模式 | `src/utils/ids.js` 的 `IdMap/ContentAttribute`、`src/utils/Renderer.js` | 需要 track changes、作者归因 |
| 位置/delta 互转 | `src/utils/position-helpers.js`、`delta-helpers.js` | 需要把编辑器 delta 与相对位置互转 |
| XML/旧类型兼容 | `src/ynode.js` 的 `_legacyTypeRef`、`readYNode` | 只在读写 v13 遗留 XML 文档时需要 |

跳转原则：分支主题都复用主链路的 `Item` / `IdSet` / update 编解码，
先把段 A–D 读完再跳，否则会重复迷路。

---

## 5. 哪些可以跳过（第一遍）

| 文件/部分 | 为什么可以跳过 |
|---|---|
| `src/utils/content-helper.js` | 当前只有 1 行空文件 |
| `src/utils/schemas.js` | 3 行 schema 声明，没有算法 |
| `src/utils/Renderer.js` 的归因渲染细节 | 不做 track changes / suggestion 时用不到 |
| `BlockSet.insertInto` 的重叠归并分支 | 只有实现 `mergeUpdates` / 离线缓存合并时才需要 |
| `updates.js` 的 `obfuscate*` / `createContentIds*` | 调试/匿名化/内容裁剪工具，不属于主链路 |
| `logUpdate` / `logNode` | 调试辅助，读不懂结构时再回来看 |
| v13 兼容字段（`_legacyTypeRef`、`YXml*RefID`） | 不处理历史 XML 文档可跳过 |
| `tests/` 全量 | 第一遍只挑段 F 的 3 个用例；其余当行为字典备查 |

---

## 6. 六个最容易写错的断言（写注释/写文档时逐条核对）

1. **「state vector 到 N 就等于 0..N-1 都收到了」**：错。有 Skip 时 state vector
   会停在空洞起点，见 `StructStore.getStateVector`。
2. **「删除会把 Item 从链表移除」**：错。删除只置位 `info` 的 deleted 并记 deleteSet；
   物理移除只发生在 GC（`doc.gc=true` 且未被 keep）。
3. **「GC 和 Skip 都是空内容，可以互换」**：错。GC 是「已回收的已知历史」，
   Skip 是「尚未收到的未知区间」；前者能推进 state vector，后者会截断它。
4. **「map 的 set 是覆盖」**：结构上是追加一个新 Item 并把旧值打删除标记；
   `_map[key]` 只是指向最新的 Item。
5. **「远端 update 和本地编辑走同一套事务语义」**：`readUpdateV2` 第一行就
   `transaction.local = false`；它会影响 update 事件、marker 清理与格式清理。
6. **「`Item.integrate` 只被远端集成调用」**：错。本地列表/map 写入、UndoManager
   重做也直接调用它；本仓 grep 到的调用点包括 `ynode.js` 的
   `typeListInsertGenericsAfter` / `insertContent` / `nodeMapSet`、
   `encoding.js` 的 `integrateStructs`、`UndoManager.redoItem`。

---

## 7. 建议的阅读节奏

- 第 1 天：段 0 + 1 + 2（坐标与仓库），约 2–3 小时；目标是能解释 state vector 与 Skip。
- 第 2 天：段 A + B（写入与 YATA），约 3–4 小时；务必手算一次并发插入。
- 第 3 天：段 C + D（类型系统与编解码），约 4 小时；画出 V2 字节布局。
- 第 4 天：段 E + F（协议与测试），约 2–3 小时；跑通一个双 doc 同步的最小脚本。

调试入口（读不懂时用）：

```js
import * as Y from '@y/y'
const d1 = new Y.Doc()
const d2 = new Y.Doc()
const t1 = d1.get('text')
const t2 = d2.get('text')
t1.insert(0, ['a'])
Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))   // d2 看到 'a'
t1.insert(1, ['b'])
t2.insert(1, ['c'])                            // 并发插入同一位置
Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2))
console.log(t1.toDelta(), t2.toDelta())        // 两端顺序必须一致
```

把 `logUpdate(Y.encodeStateAsUpdate(d1))` 的输出与 `Item.origin/rightOrigin` 对照，
是理解 YATA 最快的方式。
