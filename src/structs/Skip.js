import * as encoding from 'lib0/encoding'

import { AbstractStruct } from './AbstractStruct.js'
import { createID } from '../utils/ID.js'

export const structSkipRefNumber = 10

/**
 * @private
 */
// Skip = “这段 clock 还没收到”的占位。先收到依赖后到 update 时，缺失区间用 Skip 填上；
// 真 struct 到达后由 StructStore.add 把 Skip 切开替换。Skip 不会被广播为内容。
export class Skip extends AbstractStruct {
  get deleted () {
    return false
  }

  delete () {}

  /**
   * @param {Skip} right
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
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset
      this.length -= offset
    }
    const store = transaction.doc.store
    store.skips.add(this.id.client, this.id.clock, this.length)
    store.add(this)
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeInfo(structSkipRefNumber)
    // write as VarUint because Skips can't make use of predictable length-encoding
    encoding.writeVarUint(encoder.restEncoder, this.length - offset)
  }

  /**
   * @param {number} diff
   */
  splice (diff) {
    const other = new Skip(createID(this.id.client, this.id.clock + diff), this.length - diff)
    this.length = diff
    return other
  }
}

/**
 * @type {10}
 */
Skip.prototype.ref = structSkipRefNumber

/**
 * @type {false}
 */
Skip.prototype.isItem = false
