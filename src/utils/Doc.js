/**
 * @module Y
 */

import { ObservableV2 } from 'lib0/observable'
import * as random from 'lib0/random'
import * as map from 'lib0/map'
import * as array from 'lib0/array'
import * as promise from 'lib0/promise'

import { StructStore } from './StructStore.js'
import { transact, generateNewClientId } from './Transaction.js'
import { YNode } from '../ynode.js'
import { $doc } from './schemas.js'

// ============================================================================
// 【中文导读】Doc = 一份协作文档的根对象
//
// 链路位置：上层类型（YNode）挂在 `doc.share` 上；所有 struct 存在 `doc.store`；
// 一次修改由 `transact()` 包成 Transaction，提交后生成增量 update 发给对端。
// 读这个文件先记住四个字段：
//   - clientID：本端身份，生成本地 ID 的 client 部分（53 位随机整数）
//   - share：顶层类型名 -> YNode，`doc.get(key, name)` 的缓存表
//   - store：StructStore，按 client 分桶存放全部 Item/GC/Skip
//   - _transaction / _transactionCleanups：事务嵌套与提交队列
//
// 关键不变量：
//   1. 同一 key 反复 `get()` 返回同一个 YNode（map.setIfUndefined）。
//   2. 本地结构在 `doc.transact(...)` 内修改；`applyUpdate` 进来的远端结构
//      会强制把事务标成 `local = false`（见 encoding.js），不能当成本地编辑。
//   3. 子文档（subdoc）不是独立世界：它通过 `_item` 指向父文档里承载它的 Item。
// ============================================================================

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 * @property {string} [DocOpts.guid] Define a globally unique identifier for this document
 * @property {string | null} [DocOpts.collectionid] Associate this document with a collection. This only plays a role if your provider has a concept of collection.
 * @property {any} [DocOpts.meta] Any kind of meta information you want to associate with this document. If this is a subdocument, remote peers will store the meta information as well.
 * @property {boolean} [DocOpts.autoLoad] If a subdocument, automatically load document. If this is a subdocument, remote peers will load the document as well automatically.
 * @property {boolean} [DocOpts.shouldLoad] Whether the document should be synced by the provider now. This is toggled to true when you call ydoc.load()
 * @property {boolean} [DocOpts.isSuggestionDoc] Set to true if this document merely suggests
 * changes. If this flag is not set in a suggestion document, automatic formatting changes will be
 * displayed as suggestions, which might not be intended.
 */

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Doc):void} DocEvents.load
 * @property {function(boolean, Doc):void} DocEvents.sync
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.updateV2
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.beforeObserverCalls
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Transaction, Doc):void} DocEvents.afterTransactionCleanup
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 * @property {function({ loaded: Set<Doc>, added: Set<Doc>, removed: Set<Doc> }, Doc, Transaction):void} DocEvents.subdocs
 */

/**
 * A Yjs instance handles the state of shared data.
 * @extends ObservableV2<DocEvents>
 */
export class Doc extends ObservableV2 {
  /**
   * @param {DocOpts} opts configuration
   */
  constructor ({ guid = random.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true, isSuggestionDoc = false } = {}) {
    super()
    // gc=false 时删除只打标记、不丢内容，快照/撤销才可能回放；gcFilter 可拒绝回收指定 Item。
    this.gc = gc
    this.gcFilter = gcFilter
    // 本端 clientID：所有本地新 Item 的 id.client 都取它；它也会写进 update，供对端区分来源。
    this.clientID = generateNewClientId()
    this.guid = guid
    this.collectionid = collectionid
    this.isSuggestionDoc = isSuggestionDoc
    this.cleanupFormatting = !isSuggestionDoc
    // 顶层共享类型的注册表：key 是用户起的名字（如 'text'），value 是统一类型 YNode。
    // 注意 v14 没有 YArray/YMap/YText 子类，形状由 YNode 的 delta name/schema 决定。
    /**
     * @type {Map<string, YNode>}
     */
    this.share = new Map()
    // 全部 struct 的权威仓库；文档顺序靠 Item.left/right 链接，这里只按 (client, clock) 存。
    this.store = new StructStore()
    /**
     * @type {Transaction | null}
     */
    this._transaction = null
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = []
    /**
     * @type {Set<Doc>}
     */
    this.subdocs = new Set()
    /**
     * If this document is a subdocument - a document integrated into another document - then _item is defined.
     * @type {Item?}
     */
    this._item = null
    this.shouldLoad = shouldLoad
    this.autoLoad = autoLoad
    this.meta = meta
    /**
     * This is set to true when the persistence provider loaded the document from the database or when the `sync` event fires.
     * Note that not all providers implement this feature. Provider authors are encouraged to fire the `load` event when the doc content is loaded from the database.
     *
     * @type {boolean}
     */
    this.isLoaded = false
    /**
     * This is set to true when the connection provider has successfully synced with a backend.
     * Note that when using peer-to-peer providers this event may not provide very useful.
     * Also note that not all providers implement this feature. Provider authors are encouraged to fire
     * the `sync` event when the doc has been synced (with `true` as a parameter) or if connection is
     * lost (with false as a parameter).
     */
    this.isSynced = false
    this.isDestroyed = false
    /**
     * Promise that resolves once the document has been loaded from a persistence provider.
     */
    this.whenLoaded = promise.create(resolve => {
      this.on('load', () => {
        this.isLoaded = true
        resolve(this)
      })
    })
    const provideSyncedPromise = () => promise.create(resolve => {
      /**
       * @param {boolean} isSynced
       */
      const eventHandler = (isSynced) => {
        if (isSynced === undefined || isSynced === true) {
          this.off('sync', eventHandler)
          resolve()
        }
      }
      this.on('sync', eventHandler)
    })
    this.on('sync', isSynced => {
      // 连接断开（false）后重建 whenSynced；重新同步成功时直接 resolve。
      // 注意 isSynced === undefined 也按“已同步”处理，兼容只发事件不带参的 provider。
      if (isSynced === false && this.isSynced) {
        this.whenSynced = provideSyncedPromise()
      }
      this.isSynced = isSynced === undefined || isSynced === true
      if (this.isSynced && !this.isLoaded) {
        // 同步成功隐含“内容已加载”，补发 load，避免 provider 只实现 sync 时 whenLoaded 永远不 resolve。
        this.emit('load', [this])
      }
    })
    /**
     * Promise that resolves once the document has been synced with a backend.
     * This promise is recreated when the connection is lost.
     * Note the documentation about the `isSynced` property.
     */
    this.whenSynced = provideSyncedPromise()
  }

  /**
   * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
   *
   * `load()` might be used in the future to request any provider to load the most current data.
   *
   * It is safe to call `load()` multiple times.
   */
  load () {
    // 只有「挂在父文档里的子文档」需要通知父事务；独立的根文档直接置 shouldLoad。
    // 这里操作的是 item.parent.doc（父文档），不是 this——因为 subdocsLoaded 属于父事务。
    const item = this._item
    if (item !== null && !this.shouldLoad) {
      transact(/** @type {any} */ (item.parent).doc, transaction => {
        transaction.subdocsLoaded.add(this)
      }, null, true)
    }
    this.shouldLoad = true
  }

  getSubdocs () {
    return this.subdocs
  }

  getSubdocGuids () {
    return new Set(array.from(this.subdocs).map(doc => doc.guid))
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @param {boolean} [local]
   * @return T
   */
  transact (f, origin = null, local = true) {
    // 薄封装：真正的嵌套/提交逻辑在 Transaction.js 的 transact()。
    // origin 会原样出现在 update 事件里，provider 用它区分“自己发出的”与“远端收到的”。
    return transact(this, f, origin, local)
  }

  /**
   * Define a shared data type.
   *
   * Multiple calls of `ydoc.get(name)` yield the same result
   * and do not overwrite each other. I.e.
   * `ydoc.get(name) === ydoc.get(name)`
   *
   * After this method is called, the type is also available on `ydoc.share.get(name)`.
   *
   * @param {string} key
   * @param {string?} name Type-name
   *
   * @return {YNode}
   */
  get (key = '', name = null) {
    // 第一次取某个 key 时创建 YNode 并立即 _integrate（挂上 doc、item=null 表示顶层）。
    // 之后同 key 直接命中 map，因此 `doc.get('x') === doc.get('x')`。
    return map.setIfUndefined(this.share, key, () => {
      const t = new YNode(name)
      t._integrate(this, null)
      return t
    })
  }

  /**
   * Converts the entire document into a js object, recursively traversing each yjs type
   * Doesn't log types that have not been defined (using ydoc.getType(..)).
   *
   * @deprecated Do not use this method and rather call toJSON directly on the shared types.
   *
   * @return {Object<string, any>}
   */
  toJSON () {
    /**
     * @type {Object<string, any>}
     */
    const doc = {}
    this.share.forEach((value, key) => {
      doc[key] = value.toJSON()
    })
    return doc
  }

  /**
   * Emit `destroy` event and unregister all event handlers.
   */
  destroy () {
    // 注意顺序：先销毁顶层类型（让绑定退订）与子文档，再处理「本 doc 自身作为子文档」的情况。
    // 若 this._item 存在，说明本 doc 是父文档里的一个 ContentDoc；销毁不能把父文档里的
    // 那个位置一起抹掉，而是造一个同 guid 的“空壳” Document 顶上，再在父事务里登记替换。
    this.isDestroyed = true
    // Tear down the top-level shared types as RDTs (emits their `'destroy'` event so any bindings
    // unsubscribe). Only top-level types are destroyed here; nested child types are not recursed.
    this.share.forEach(type => type.destroy())
    array.from(this.subdocs).forEach(subdoc => subdoc.destroy())
    const item = this._item
    if (item !== null) {
      this._item = null
      const content = /** @type {ContentDoc} */ (item.content)
      /**
       * new content doc which replaces the new one
       */
      const contentDoc = new Doc({ guid: this.guid, ...content.opts, shouldLoad: false })
      content.doc = contentDoc
      contentDoc._item = item
      transact(/** @type {any} */ (item).parent.doc, transaction => {
        if (!item.deleted) {
          transaction.subdocsAdded.add(contentDoc)
        }
        transaction.subdocsRemoved.add(this)
      }, null, true)
    }
    this.emit('destroy', [this])
    super.destroy()
  }
}

Doc.prototype.$type = $doc
