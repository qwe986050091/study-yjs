import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as error from 'lib0/error'

// ============================================================================
// 【中文导读】ID = (client, clock) 二元组
//
// clock 是该 client 本地的逻辑时钟，按 struct 长度递增；`ID(client, clock)` 唯一
// 标识一个 struct 的起点。整个 Yjs 的依赖、删除集、state vector 都以它为坐标。
// 注意：ID 不是对象引用，不同实例只要 client/clock 相同就相等（compareIDs）。
// ============================================================================

export class ID {
  /**
   * @param {number} client client id
   * @param {number} clock unique per client id, continuous number
   */
  constructor (client, clock) {
    /**
     * Client id
     * @type {number}
     */
    this.client = client
    /**
     * unique per client id, continuous number
     * @type {number}
     */
    this.clock = clock
  }
}

/**
 * @param {ID | null} a
 * @param {ID | null} b
 * @return {boolean}
 *
 * @function
 */
export const compareIDs = (a, b) => a === b || (a !== null && b !== null && a.client === b.client && a.clock === b.clock)
// 值比较，不比较引用。YATA 的锚点比较、state vector 判等都用它。

/**
 * @param {number} client
 * @param {number} clock
 *
 * @private
 * @function
 */
export const createID = (client, clock) => new ID(client, clock)

/**
 * @param {encoding.Encoder} encoder
 * @param {ID} id
 *
 * @private
 * @function
 */
export const writeID = (encoder, id) => {
  encoding.writeVarUint(encoder, id.client)
  encoding.writeVarUint(encoder, id.clock)
}

/**
 * Read ID.
 * * If first varUint read is 0xFFFFFF a RootID is returned.
 * * Otherwise an ID is returned
 *
 * @param {decoding.Decoder} decoder
 * @return {ID}
 *
 * @private
 * @function
 */
export const readID = decoder =>
  createID(decoding.readVarUint(decoder), decoding.readVarUint(decoder))

/**
 * The top types are mapped from y.share.get(keyname) => type.
 * `type` does not store any information about the `keyname`.
 * This function finds the correct `keyname` for `type` and throws otherwise.
 *
 * @param {YNode<any>} type
 * @return {string}
 *
 * @private
 * @function
 */
export const findRootTypeKey = type => {
  // 顶层 YNode 只知道 doc，不记得自己挂在哪个 key 上；编码 parent 时又要这个 key，
  // 所以反向遍历 doc.share。找不到说明 type 不是顶层类型（或已脱离文档）。
  // @ts-ignore _y must be defined, otherwise unexpected case
  for (const [key, value] of type.doc.share.entries()) {
    if (value === type) {
      return key
    }
  }
  throw error.unexpectedCase()
}
