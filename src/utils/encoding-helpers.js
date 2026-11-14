import * as encoding from 'lib0/encoding'
import * as math from 'lib0/math'
import * as array from 'lib0/array'

import { findIndexSS } from './transaction-helpers.js'
import { Skip } from '../structs/Skip.js'
import { createID } from './ID.js'
import { writeIdSet } from './ids.js'

// ============================================================================
// 【中文导读】encoding-helpers = 把 store / transaction 的 struct 写进 update
//
// 三个入口层层收窄：
//   writeStructs(store 的一段) -> writeStructsFromIdSet(按 ID 集合选 struct)
//   -> writeStructsFromTransaction(只写本事务 insertSet)
// 与 BlockSet.writeBlockSet 的区别：这里直接读 StructStore，按给定时钟区间
// 找 struct，跨区间的首尾会带 offset 只写命中部分；Skip 也按缺口写出。
// ============================================================================

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Array<GC|Item|Skip>} structs All structs by `client`
 * @param {number} client
 * @param {Array<IdRange>} idranges
 *
 * @function
 */
export const writeStructs = (encoder, structs, client, idranges) => {
  // idranges 是“要写的 clock 区间”，先与 structs 的实际范围求交，再二分定位。
  // 区间之间若有空洞，用 Skip 填上，保证解码端看到的 clock 连续。
  // 同一 struct 跨区间边界时，start/end 用 offset 只写一部分。
  let structsToWrite = 0 // this accounts for the skips
  /**
   * @type {Array<{ start: number, end: number, startClock: number, endClock: number }>}
   */
  const indexRanges = []
  const firstPossibleClock = structs[0].id.clock
  const lastStruct = array.last(structs)
  const lastPossibleClock = lastStruct.id.clock + lastStruct.length
  idranges.forEach(idrange => {
    const startClock = math.max(idrange.clock, firstPossibleClock)
    const endClock = math.min(idrange.clock + idrange.len, lastPossibleClock)
    if (startClock >= endClock) return // structs for this range do not exist
    // inclusive start
    const start = findIndexSS(structs, startClock)
    // exclusive end
    const end = findIndexSS(structs, endClock - 1) + 1
    structsToWrite += end - start
    indexRanges.push({
      start,
      end,
      startClock,
      endClock
    })
  })
  structsToWrite += idranges.length - 1
  // start writing with this clock. this is updated to the next clock that we expect to write
  let clock = indexRanges[0].startClock
  // write # encoded structs
  encoding.writeVarUint(encoder.restEncoder, structsToWrite)
  encoder.writeClient(client)
  // write clock
  encoding.writeVarUint(encoder.restEncoder, clock)
  indexRanges.forEach(indexRange => {
    const skipLen = indexRange.startClock - clock
    if (skipLen > 0) {
      new Skip(createID(client, clock), skipLen).write(encoder, 0)
      clock += skipLen
    }
    for (let i = indexRange.start; i < indexRange.end; i++) {
      const struct = structs[i]
      const structEnd = struct.id.clock + struct.length
      const offsetEnd = math.max(structEnd - indexRange.endClock, 0)
      struct.write(encoder, clock - struct.id.clock, offsetEnd)
      clock = structEnd - offsetEnd
    }
  })
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {IdSet} idset
 *
 * @todo at the moment this writes the full deleteset range
 *
 * @private
 * @function
 */
export const writeStructsFromIdSet = (encoder, store, idset) => {
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, idset.clients.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array.from(idset.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, ids]) => {
    const idRanges = ids.getIds()
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
    writeStructs(encoder, structs, client, idRanges)
  })
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const writeStructsFromTransaction = (encoder, transaction) => writeStructsFromIdSet(encoder, transaction.doc.store, transaction.insertSet)

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 * @return {boolean} Whether data was written.
 */
export const writeUpdateMessageFromTransaction = (encoder, transaction) => {
  // 事务提交时生成增量 update：insertSet 的 struct + deleteSet。
  // 两者都空则返回 false，调用方不会 emit 空 update。
  if (transaction.deleteSet.clients.size === 0 && transaction.insertSet.clients.size === 0) {
    return false
  }
  writeStructsFromTransaction(encoder, transaction)
  writeIdSet(encoder, transaction.deleteSet)
  return true
}
