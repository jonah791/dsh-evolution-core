/**
 * 2026-11-03（t-d9d60529）：裁决必须**显式**回答「这次有什么可以带走」。
 *
 * 背景：我的裁决曾是整体裁决——一个「整体不适配」的产物里，有用的组件会随它一起被归档。
 * 实例：DKGI 两场景均不适配 ⇒ 整条归档，但它产出一条新判据「痛点存在 ≠ 痛点有代价」。
 *
 * 这里是 fail-closed 的尸体测试：verdict 不带 salvage 必须被**拒**，`["none"]` 必须被接受，
 * 且「显式 none」与「忘了写」在落盘数据上必须可区分——否则纪律等于没有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeSalvage, validateSalvage } from '../lib/core.js'
import { appendHistory } from '../lib/history-store.js'

test('corpse: verdict without salvage is rejected', () => {
  assert.ok(validateSalvage('verdict', undefined), 'undefined 必须被拒')
  assert.ok(validateSalvage('verdict', []), '空数组必须被拒')
  assert.ok(validateSalvage('verdict', ['  ', '']), '只有空白项不算给了')
})

test('verdict with explicit ["none"] passes — 「想过、没有」≠「忘了写」', () => {
  assert.equal(validateSalvage('verdict', ['none']), null)
})

test('verdict carrying real components passes', () => {
  assert.equal(validateSalvage('verdict', ['判据:痛点存在 ≠ 痛点有代价']), null)
})

test('non-verdict types are not gated (cycle/note/wire 不该被这条规则拖住)', () => {
  for (const t of ['cycle', 'note', 'wire', 'forge', 'evolve', 'reflect', 'checkpoint']) {
    assert.equal(validateSalvage(t, undefined), null, `${t} 不该被 salvage 卡住`)
  }
})

test('normalizeSalvage trims, drops blanks, and tolerates non-arrays', () => {
  assert.deepEqual(normalizeSalvage([' a ', '', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeSalvage(undefined), [])
  assert.deepEqual(normalizeSalvage('not-an-array'), [])
})

test('appendHistory persists salvage, and omits the field entirely when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-salvage-'))
  try {
    appendHistory(dir, { type: 'verdict', detail: '裁决一', salvage: ['判据:某条', '  '] })
    appendHistory(dir, { type: 'cycle', detail: '感知圈' })
    const rows = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(rows[0].salvage, ['判据:某条'], '空白项要被丢掉')
    assert.equal('salvage' in rows[1], false, '没有就是字段不存在，不是空数组')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('old rows without salvage still read back fine (不做迁移，按缺失处理)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-salvage-'))
  try {
    appendHistory(dir, { type: 'verdict', detail: '老记录', evidence: 'path:1' })
    const rows = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows[0].salvage, undefined)
    assert.equal(rows[0].evidence, 'path:1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
