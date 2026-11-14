import { AbstractStruct, addStructToIdSet } from './AbstractStruct.js'
import { createID } from '../utils/ID.js'

export const structGCRefNumber = 0

/**
 * @private
 */
// GC = 已回收内容的“墓碑”。它不再保存原文，只保留 id + length，
// 以便 state vector / clock 对齐仍然成立；读到它时不会恢复任何内容。
export class GC extends AbstractStruct {
  get deleted () {
    return true
  }

  delete () {}

  /**
   * @param {GC | Skip | Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (this.constructor !== right.constructor) {
      return false
    }
    this.length += right.length
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset - @todo remove offset parameter
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset
      this.length -= offset
    }
    transaction.deleteSet.add(this.id.client, this.id.clock, this.length)
    addStructToIdSet(transaction.insertSet, this)
    transaction.doc.store.add(this)
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   * @param {number} offsetEnd
   */
  write (encoder, offset, offsetEnd) {
    encoder.writeInfo(structGCRefNumber)
    encoder.writeLen(this.length - offset - offsetEnd)
  }

  /**
   * gc structs can't be spliced.
   *
   * If this feature is required in the future, then need to try to merge this struct after
   * transaction.
   *
   * @param {number} diff
   */
  splice (diff) {
    const other = new GC(createID(this.id.client, this.id.clock + diff), this.length - diff)
    this.length = diff
    return other
  }
}

/**
 * @type {0}
 */
GC.prototype.ref = structGCRefNumber

/**
 * @type {false}
 */
GC.prototype.isItem = false
