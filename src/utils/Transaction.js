import * as error from 'lib0/error'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as logging from 'lib0/logging'
import { callAll } from 'lib0/function'

import { ContentFormat } from '../structs/Item.js'
import { getStateVector } from './StructStore.js'
import { callEventHandlerListeners } from './EventHandler.js'
import { createIdSet, iterateStructsByIdSet } from './ids.js'
import { GC } from '../structs/GC.js'
import { YEvent } from './YEvent.js'
import { writeUpdateMessageFromTransaction } from './encoding-helpers.js'
import { UpdateEncoderV1, UpdateEncoderV2 } from './UpdateEncoder.js'
import { findIndexSS, updateCurrentFormats, cleanupFormattingGap, tryGcDeleteSet, tryMerge, tryToMergeWithLefts, cleanupContextlessFormattingGap } from './transaction-helpers.js'
import * as random from 'lib0/random'

export const generateNewClientId = random.uint53

// ============================================================================
// 【中文导读】Transaction = 一次原子修改及其提交清理
//
// 链路位置：
//   本地写入（YNode 的 insert/delete/setAttr）都要求先有 transaction；
//   远端 update 经 encoding.js 的 readUpdateV2 也开一个事务，但 local=false。
//   事务提交后，Transaction.js 负责：触达观察者 -> GC/合并 -> 生成增量 update。
//
// 三个集合是全部后续逻辑的输入，先记牢：
//   - insertSet：本事务新插入的 ID 区间（= 要广播的新 struct）
//   - deleteSet：本事务删除的 ID 区间
//   - cleanUps：格式清理顺带删掉的区间（deleteSet 的子集，用于区分“用户删”与“清理删”）
//
// 阅读顺序建议：constructor -> transact() -> cleanupTransactions()。
// ============================================================================

/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number on messages sent and the number of observer calls.
 * If possible the user of this library should bundle as many changes as
 * possible. Here is an example to illustrate the advantages of bundling:
 *
 * @example
 * const ydoc = new Y.Doc()
 * const map = ydoc.get('map')
 * // Log content when change is triggered
 * map.observe(() => {
 *   console.log('change triggered')
 * })
 * // Each change on the map type triggers a log message:
 * map.setAttr('a', 0) // => "change triggered"
 * map.setAttr('b', 0) // => "change triggered"
 * // When put in a transaction, it will trigger the log after the transaction:
 * ydoc.transact(() => {
 *   map.setAttr('a', 1)
 *   map.setAttr('b', 1)
 * }) // => "change triggered"
 *
 * @public
 */
export class Transaction {
  /**
   * @param {Doc} doc
   * @param {any} origin
   * @param {boolean} local
   */
  constructor (doc, origin, local) {
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    this.doc = doc
    /**
     * Describes the set of deleted items by ids
     */
    this.deleteSet = createIdSet()
    /**
     * Describes the set of items that are cleaned up / deleted by ids. It is a subset of
     * this.deleteSet
     */
    this.cleanUps = createIdSet()
    /**
     * Describes the set of inserted items by ids
     */
    // 注意：这是“ID 区间集合”，不是 struct 列表；真正 struct 已写进 doc.store。
    // 提交时用它生成 update，也用它判断某个 Item 是不是本事务新建的（addChangedTypeToTransaction）。
    this.insertSet = createIdSet()
    /**
     * Holds the state before the transaction started.
     * @type {Map<Number,Number>?}
     */
    this._beforeState = null
    /**
     * Holds the state after the transaction.
     * @type {Map<Number,Number>?}
     */
    this._afterState = null
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<YNode,Set<String|null>>}
     */
    // 直接变更的类型 -> 变更的 key 集合；null 表示列表内容变了（不是某个 map key）。
    this.changed = new Map()
    /**
     * Stores the events for the types that observe also child elements.
     * It is mainly used by `observeDeep`.
     * @type {Map<YNode,Array<YEvent<any>>>}
     */
    // 与 changed 的区别：这里会把事件向上冒泡到所有祖先，供 observeDeep / 'delta' 使用。
    this.changedParentTypes = new Map()
    /**
     * @type {Array<AbstractStruct>}
     */
    this._mergeStructs = []
    /**
     * @type {any}
     */
    this.origin = origin
    /**
     * Stores meta information on the transaction
     * @type {Map<any,any>}
     */
    this.meta = new Map()
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    this.local = local
    /**
     * @type {Set<Doc>}
     */
    this.subdocsAdded = new Set()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsRemoved = new Set()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsLoaded = new Set()
    /**
     * @type {boolean}
     */
    this._needFormattingCleanup = false
    this._done = false
  }

  /**
   * Holds the state before the transaction started.
   *
   * @deprecated
   * @type {Map<Number,Number>}
   */
  get beforeState () {
    // 用“当前 store 的 state vector” + “本事务插入区间的起点”反推事务前状态。
    // 这是 deprecated 的兼容 API；新代码应直接用 encodeStateVector / snapshot。
    if (this._beforeState == null) {
      const sv = getStateVector(this.doc.store)
      this.insertSet.clients.forEach((ranges, client) => {
        sv.set(client, ranges.getIds()[0].clock)
      })
      this._beforeState = sv
    }
    return this._beforeState
  }

  /**
   * Holds the state after the transaction.
   *
   * @deprecated
   * @type {Map<Number,Number>}
   */
  get afterState () {
    // 必须在事务 done 之后读：insertSet 的末端才是事务结束时的 clock。
    if (!this._done) error.unexpectedCase()
    if (this._afterState == null) {
      const sv = getStateVector(this.doc.store)
      this.insertSet.clients.forEach((_ranges, client) => {
        const ranges = _ranges.getIds()
        const d = ranges[ranges.length - 1]
        sv.set(client, d.clock + d.len)
      })
      this._afterState = sv
    }
    return this._afterState
  }
}

/**
 * This function is experimental and subject to change / be removed.
 *
 * Ideally, we don't need this function at all. Formats should be cleaned up
 * automatically after each change. This function iterates twice over the complete YText type
 * and removes unnecessary formats. This is also helpful for testing.
 *
 * This function won't be exported anymore as soon as there is confidence that the YText type works as intended.
 *
 * @param {YNode} type
 * @return {number} How many formats have been cleaned up.
 */
export const cleanupYTextFormatting = type => {
  if (!type.doc?.cleanupFormatting) return 0
  let res = 0
  transact(/** @type {Doc} */ (type.doc), transaction => {
    let start = /** @type {Item} */ (type._start)
    let end = type._start
    let startFormats = map.create()
    const currentFormats = map.copy(startFormats)
    while (end) {
      if (end.deleted === false) {
        switch (end.content.constructor) {
          case ContentFormat:
            updateCurrentFormats(currentFormats, /** @type {ContentFormat} */ (end.content))
            break
          default:
            res += cleanupFormattingGap(transaction, start, end, startFormats, currentFormats)
            startFormats = map.copy(currentFormats)
            start = end
            break
        }
      }
      end = end.right
    }
  })
  return res
}

/**
 * @param {Array<Transaction>} transactionCleanups
 * @param {number} i
 */
const cleanupTransactions = (transactionCleanups, i) => {
  // 提交阶段（按顺序）：
  //   1) beforeObserverCalls
  //   2) 观察者（浅层 changed / 深层 changedParentTypes）
  //   3) afterTransaction
  //   4) finally：GC、struct 合并、清理
  //   5) afterTransactionCleanup、生成增量 update、子文档事件
  // 注意 4) 在 finally 里：观察者抛异常也必须完成 GC/合并，否则 store 会处于半提交状态。
  if (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i]
    transaction._done = true
    const doc = transaction.doc
    const store = doc.store
    const ds = transaction.deleteSet
    const mergeStructs = transaction._mergeStructs
    // insertIntoIdSet(store.ds, ds)
    try {
      doc.emit('beforeObserverCalls', [transaction, doc])
      /**
       * An array of event callbacks.
       *
       * Each callback is called even if the other ones throw errors.
       *
       * @type {Array<function():void>}
       */
      const fs = []
      // 浅层观察者：每个直接变更的类型收集成一个回调，最终用 callAll 一起执行。
      // observe events on changed types. Deleted types are included: `callTypeObservers` tracks
      // the event in `changedParentTypes` unconditionally (so changes inside a deleted type — e.g.
      // a suggestion-deleted tombstone that a custom renderer still renders — bubble to live
      // ancestors) and decides itself whether the type's own observers fire.
      transaction.changed.forEach((subs, itemtype) =>
        fs.push(() => {
          itemtype._callObserver(transaction, subs)
        })
      )
      fs.push(() => {
        // 深层观察者 / 'delta' 通道：changedParentTypes 里同时包含直接变更类型和它的祖先。
        // 已删除且没有 renderer 的类型直接跳过：它的内容不可见，不该再通知外部。
        // deep observe events + the RDT `'delta'` channel. `changedParentTypes` holds the changed
        // type AND all of its ancestors, so both `observeDeep` and `'delta'` bubble identically.
        transaction.changedParentTypes.forEach((events, type) => {
          // We need to think about the possibility that the user transforms the
          // Y.Doc in the event.
          // Deleted types are tracked (so changes inside them bubble to live ancestors) but fire
          // only while something still renders them — i.e. they have a renderer attached.
          if (type._item !== null && type._item.deleted && type._renderer === null) return
          const hasDeep = type._dEH.l.length > 0
          const hasDeltaListeners = (type._observers.get('delta')?.size ?? 0) > 0
          const maintaining = type._delta !== null
          if (!hasDeep && !hasDeltaListeners && !maintaining) return
          /**
           * @type {YEvent<any>}
           */
          const deepEventHandler = events.find(event => event.target === type) || new YEvent(type, transaction, new Set(null))
          if (hasDeep) {
            callEventHandlerListeners(type._dEH, deepEventHandler, transaction)
          }
          if (hasDeltaListeners || maintaining) {
            // the type-rooted deep delta of this transaction (a nested `modify` chain for ancestors)
            const change = /** @type {any} */ (deepEventHandler.getDelta({ renderer: type._renderer, deep: true }).done())
            // a base-renderer type doesn't render deleted content, so a change that happened
            // entirely inside a deleted subtree renders to an empty delta — don't emit those no-ops
            if (!change.isEmpty()) {
              type._delta?.apply(change) // keep the cache current (incl. ancestors and diff-renderer attributions) — builder API only, see the YNode._delta fingerprint-memo invariant
              if (hasDeltaListeners) type.emit('delta', [change, transaction.origin])
            }
          }
        })
      })
      fs.push(() => doc.emit('afterTransaction', [transaction, doc]))
      callAll(fs, [])
      if (transaction._needFormattingCleanup && doc.cleanupFormatting) {
        cleanupYTextAfterTransaction(transaction)
      }
    } finally {
      // Replace deleted items with ItemDeleted / GC.
      // This is where content is actually remove from the Yjs Doc.
      // GC 条件：doc.gc=true、Item 已删除、未标 keep、且 gcFilter 放行。
      // 回收后内容被丢弃；若父级也被回收，整个 Item 会被替换成等长 GC。
      if (doc.gc) {
        tryGcDeleteSet(transaction, ds, doc.gcFilter)
      }
      tryMerge(ds, store)

      // on all affected store.clients props, try to merge
      // 合并相邻且同 client、clock 连续的 Item，减少对象数（纯优化，不改变语义）。
      transaction.insertSet.clients.forEach((ids, client) => {
        const firstClock = ids.getIds()[0].clock
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
        // we iterate from right to left so we can safely remove entries
        const firstChangePos = math.max(findIndexSS(structs, firstClock), 1)
        for (let i = structs.length - 1; i >= firstChangePos;) {
          i -= 1 + tryToMergeWithLefts(structs, i)
        }
      })
      // try to merge mergeStructs
      // @todo: it makes more sense to transform mergeStructs to a DS, sort it, and merge from right to left
      //        but at the moment DS does not handle duplicates
      for (let i = mergeStructs.length - 1; i >= 0; i--) {
        const { client, clock } = mergeStructs[i].id
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
        const replacedStructPos = findIndexSS(structs, clock)
        if (replacedStructPos + 1 < structs.length) {
          if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
            continue // no need to perform next check, both are already merged
          }
        }
        if (replacedStructPos > 0) {
          tryToMergeWithLefts(structs, replacedStructPos)
        }
      }
      if (!transaction.local && transaction.insertSet.clients.has(doc.clientID)) {
        // 远端 update 里出现了“本端 clientID”的新 struct：说明有另一个实例在用同一个 clientID。
        // 不换 ID 会让后续本地写入与对端历史纠缠，这里直接换一个新 clientID。
        logging.print(logging.ORANGE, logging.BOLD, '[yjs] ', logging.UNBOLD, logging.RED, 'Changed the client-id because another client seems to be using it.')
        doc.clientID = generateNewClientId()
      }
      // @todo Merge all the transactions into one and provide send the data as a single update message
      doc.emit('afterTransactionCleanup', [transaction, doc])
      // 增量 update 是“本事务 insertSet + deleteSet”的编码；没有这两个集合的事件不广播。
      if (doc._observers.has('update')) {
        const encoder = new UpdateEncoderV1()
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
        if (hasContent) {
          doc.emit('update', [encoder.toUint8Array(), transaction.origin, doc, transaction])
        }
      }
      if (doc._observers.has('updateV2')) {
        const encoder = new UpdateEncoderV2()
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
        if (hasContent) {
          doc.emit('updateV2', [encoder.toUint8Array(), transaction.origin, doc, transaction])
        }
      }
      const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction
      if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
        subdocsAdded.forEach(subdoc => {
          subdoc.clientID = doc.clientID
          if (subdoc.collectionid == null) {
            subdoc.collectionid = doc.collectionid
          }
          doc.subdocs.add(subdoc)
        })
        subdocsRemoved.forEach(subdoc => doc.subdocs.delete(subdoc))
        doc.emit('subdocs', [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction])
        subdocsRemoved.forEach(subdoc => subdoc.destroy())
      }

      if (transactionCleanups.length <= i + 1) {
        // 队列清空：所有嵌套事务都提交完了，发 afterAllTransactions。
        doc._transactionCleanups = []
        doc.emit('afterAllTransactions', [doc, transactionCleanups])
      } else {
        // 观察者里又开了新事务：不递归调用，而是用下标串行消费，避免深层调用栈。
        cleanupTransactions(transactionCleanups, i + 1)
      }
    }
  }
}

/**
 * This will be called by the transaction once the event handlers are called to potentially cleanup
 * formats.
 *
 * @param {Transaction} transaction
 */
export const cleanupYTextAfterTransaction = transaction => {
  /**
   * @type {Set<YNode>}
   */
  const needFullCleanup = new Set()
  // check if another formatting item was inserted
  const doc = transaction.doc
  iterateStructsByIdSet(transaction, transaction.insertSet, (item) => {
    if (
      !item.deleted && /** @type {Item} */ (item).content.constructor === ContentFormat && item.constructor !== GC
    ) {
      needFullCleanup.add(/** @type {any} */ (item).parent)
    }
  })
  // cleanup in a new transaction
  transact(doc, (t) => {
    iterateStructsByIdSet(transaction, transaction.deleteSet, item => {
      if (item instanceof GC || !(/** @type {YNode} */ (item.parent)._hasFormatting) || needFullCleanup.has(/** @type {YNode} */ (item.parent))) {
        return
      }
      const parent = /** @type {YNode} */ (item.parent)
      if (item.content.constructor === ContentFormat) {
        needFullCleanup.add(parent)
      } else {
        // If no format was inserted or deleted, we can make due with contextless
        // formatting cleanups.
        // Contextless: it is not necessary to compute currentFormats for the affected position.
        cleanupContextlessFormattingGap(t, item)
      }
    })
    // If a formatting item was inserted, we simply clean the whole type.
    // We need to compute currentFormats for the current position anyway.
    for (const yText of needFullCleanup) {
      cleanupYTextFormatting(yText)
    }
  })
}

/**
 * Implements the functionality of `y.transact(()=>{..})`
 *
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} [origin=true]
 * @param {boolean} [local=true]
 * @return {T}
 *
 * @function
 */
export const transact = (doc, f, origin = null, local = true) => {
  const transactionCleanups = doc._transactionCleanups
  let initialCall = false
  /**
   * @type {any}
   */
  let result = null
  if (doc._transaction === null) {
    // 最外层调用：新建事务并入队。嵌套调用（doc._transaction 非空）直接复用当前事务，
    // 因此 `transact(() => transact(...))` 仍然只广播一条 update。
    initialCall = true
    doc._transaction = new Transaction(doc, origin, local)
    transactionCleanups.push(doc._transaction)
    if (transactionCleanups.length === 1) {
      doc.emit('beforeAllTransactions', [doc])
    }
    doc.emit('beforeTransaction', [doc._transaction, doc])
  }
  try {
    result = f(doc._transaction)
  } finally {
    if (initialCall) {
      // 只有最外层负责收尾；即使 f 抛异常也要把 _transaction 清空并跑清理，
      // 否则文档会永久卡在“有未提交事务”的状态。
      const finishCleanup = doc._transaction === transactionCleanups[0]
      doc._transaction = null
      if (finishCleanup) {
        // The first transaction ended, now process observer calls.
        // Observer call may create new transactions for which we need to call the observers and do cleanup.
        // We don't want to nest these calls, so we execute these calls one after
        // another.
        // Also we need to ensure that all cleanups are called, even if the
        // observes throw errors.
        // This file is full of hacky try {} finally {} blocks to ensure that an
        // event can throw errors and also that the cleanup is called.
        cleanupTransactions(transactionCleanups, 0)
      }
    }
  }
  return result
}
