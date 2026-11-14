import * as error from 'lib0/error'

// ============================================================================
// 【中文导读】AbstractStruct = Item / GC / Skip 的最小公共契约
//
// 一个 struct 只承诺三件事：`id`（client + 起始 clock）、`length`（覆盖多少 clock）、
// 以及可被 Store 调用的 splice / mergeWith / write / integrate。
// 文档顺序（left/right）只有 Item 有；GC/Skip 只存在于 StructStore 的 clock 数组中。
// ============================================================================

export class AbstractStruct {
  /**
   * @param {ID} id
   * @param {number} length
   */
  constructor (id, length) {
    this.id = id
    this.length = length
  }

  /**
   * @type {boolean}
   */
  get deleted () {
    throw error.methodUnimplemented()
  }

  /**
   * Merge this struct with the item to the right.
   * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
   * Also this method does *not* remove right from StructStore!
   * @param {GC|Item|Skip} _right
   * @return {boolean} whether this merged with right
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder The encoder to write data to.
   * @param {number} _offset
   * @param {number} _encodingRef
   */
  write (_encoder, _offset, _encodingRef) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   * @param {number} _offset
   */
  integrate (_transaction, _offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {number} _diff
   * @return {GC|Item|Skip}
   */
  splice (_diff) {
    throw error.methodUnimplemented()
  }
}

/**
 * @param {IdSet} idSet
 * @param {AbstractStruct} struct
 *
 * @private
 * @function
 */
export const addStructToIdSet = (idSet, struct) => idSet.add(struct.id.client, struct.id.clock, struct.length)
