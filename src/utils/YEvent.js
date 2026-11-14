import * as map from 'lib0/map'
import * as set from 'lib0/set'

import { diffIdSet, intersectSets, mergeIdSets } from './ids.js'
import { createAbsolutePositionFromRelativePosition, createRelativePosition } from './RelativePosition.js'

// ============================================================================
// 【中文导读】YEvent = 观察者拿到的一次变更视图
//
// 它不复制数据，只持有：
//   - target / transaction：谁变了、哪个事务
//   - childListChanged / keysChanged：列表变了还是某些 map key 变了
//   - _delta：按需从 transaction.insertSet/deleteSet 投影出的 delta（惰性计算）
// 因此事件对象只在观察者回调期间有效；别把它存起来跨事务使用。
// ============================================================================

/**
 * @template {DeltaConf} DConf
 * YEvent describes the changes on a YNode.
 */
export class YEvent {
  /**
   * @param {YNode<DConf>} target The changed type.
   * @param {import('./Transaction.js').Transaction} transaction
   * @param {Set<any>?} subs The keys that changed
   */
  constructor (target, transaction, subs) {
    /**
     * The type on which this event was created on.
     * @type {import('../ynode.js').YNode<DConf>}
     */
    this.target = target
    /**
     * The current target on which the observe callback is called.
     * @type {YNode<any>}
     */
    this.currentTarget = target
    /**
     * The transaction that triggered this event.
     * @type {import('./Transaction.js').Transaction}
     */
    this.transaction = transaction
    /**
     * @type {Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>|null}
     */
    this._delta = null
    /**
     * @type {Delta<DConf>|null}
     */
    this._deltaDeep = null
    /**
     * Whether the children changed.
     * @type {Boolean}
     * @private
     */
    this.childListChanged = false
    /**
     * Set of all changed attributes.
     * @type {Set<string>}
     */
    this.keysChanged = new Set()
    subs?.forEach((sub) => {
      if (sub === null) {
        this.childListChanged = true
      } else {
        this.keysChanged.add(sub)
      }
    })
  }

  /**
   * Check if a struct is deleted by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  deletes (struct) {
    // 判断“本事务是否删了这段”。注意它和 change.deleted 不同：
    // 一个在本事务里“先插入后删除”的 struct 也会返回 true。
    return this.transaction.deleteSet.hasId(struct.id)
  }

  /**
   * Check if a struct is added by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  adds (struct) {
    return this.transaction.insertSet.hasId(struct.id)
  }

  /**
   * @template {boolean} [Deep=false]
   * @param {object} [opts]
   * @param {AbstractRenderer?} [opts.renderer] - renders the content (with attributions); defaults to the target type's active renderer (see {@link YNode#useRenderer}), i.e. `null` (render as-is) unless changed
   * @param {Deep} [opts.deep]
   * @return {Deep extends true ? Delta<DConf> : Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
   *
   * @public
   */
  getDelta ({ renderer = this.target._renderer, deep } = {}) {
    // 惰性计算 delta：把 target 的 toDelta 限定在本事务的 insert/deleted 区间内。
    // 浅层只投影 target 自身；deep 会带上子类型变更（供 observeDeep）。
    // renderer 决定嵌套 YNode 如何展开成普通值。
    const insertSet = this.transaction.insertSet
    const deleteSet = this.transaction.deleteSet
    // content that was both inserted AND deleted by this transaction is normally invisible — but a
    // renderer may still render it (e.g. remote content integrated under a suggestion-deleted
    // parent is auto-deleted yet rendered with a delete attribution). Render
    // `(I ∪ D) − ((I ∩ D) − renderer.attributed)`: the symmetric difference plus the attributed
    // part of the intersection.
    const both = intersectSets(insertSet, deleteSet)
    const itemsToRender = mergeIdSets(
      (both.isEmpty() || renderer === null)
        ? [diffIdSet(insertSet, deleteSet), diffIdSet(deleteSet, insertSet)]
        : [diffIdSet(insertSet, deleteSet), diffIdSet(deleteSet, insertSet), intersectSets(both, renderer.attributed)]
    )
    /**
     * @todo this should be done only one in the transaction step
     *
     * @type {Map<YNode,Set<string|null>>|null}
     */
    let modified = this.transaction.changed
    if (deep) {
      // need to add deep changes to copy of modified
      const dchanged = new Map()
      modified.forEach((attrs, type) => {
        dchanged.set(type, new Set(attrs))
      })
      for (let m of modified.keys()) {
        while (m._item != null) {
          const item = m._item
          const ms = map.setIfUndefined(dchanged, item?.parent, set.create)
          if (item && !ms.has(item.parentSub)) {
            ms.add(item.parentSub)
            m = /** @type {any} */ (item.parent)
          } else {
            break
          }
        }
      }
      modified = dchanged
    }
    return /** @type {any} */ (this.target.toDelta({ renderer, itemsToRender, retainDeletes: true, insertedItems: insertSet, deep: !!deep, modified }))
  }

  /**
   * Compute the changes in the delta format.
   * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
   *
   * @type {Delta<import('../ynode.js').DeltaConfDeltaToYNode<DConf>>} The Delta representation of this type.
   * @public
   */
  get delta () {
    return /** @type {any} */ (this._delta ?? (this._delta = this.getDelta().done()))
  }

  /**
   * Compute the changes in the delta format.
   * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
   *
   * @type {Delta<DConf>} The Delta representation of this type.
   * @public
   */
  get deltaDeep () {
    return /** @type {any} */ (this._deltaDeep ?? (this._deltaDeep = /** @type {any} */ (this.getDelta({ deep: true }))))
  }
}

/**
 * Compute the path from this type to the specified target.
 *
 * @example
 *   // `child` should be accessible via `type.get(path[0]).get(path[1])..`
 *   const path = type.getPathTo(child)
 *   // assuming `type instanceof YArray`
 *   console.log(path) // might look like => [2, 'key1']
 *   child === type.get(path[0]).get(path[1])
 *
 * @param {YNode} parent
 * @param {YNode} child target
 * @param {AbstractRenderer?} renderer
 * @return {Array<string|number>} Path to the target
 *
 * @private
 * @function
 */
export const getPathTo = (parent, child, renderer = null) => {
  const path = []
  const doc = /** @type {Doc} */ (parent.doc)
  while (child._item !== null && child !== parent) {
    if (child._item.parentSub !== null) {
      // parent is map-ish
      path.unshift(child._item.parentSub)
    } else {
      const parent = /** @type {import('../ynode.js').YNode} */ (child._item.parent)
      // parent is array-ish
      const apos = /** @type {import('../utils/RelativePosition.js').AbsolutePosition} */ (createAbsolutePositionFromRelativePosition(createRelativePosition(parent, child._item.id), doc, false, renderer))
      path.unshift(apos.index)
    }
    child = /** @type {YNode} */ (child._item.parent)
  }
  return path
}
