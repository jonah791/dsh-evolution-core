/**
 * dsh-evolution-core — history-store.ts 回归测试（履历 JSONL：容错读 / 失败不抛写）
 * 运行：node --test tests/history-store.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historyPath, readHistory, appendHistory, nextHistoryId } from '../lib/history-store.js'

const root = mkdtempSync(join(tmpdir(), 'evocore-history-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const dir = (name) => join(root, name)

// ---------- historyPath ----------

test('historyPath：dataDir/history.jsonl', () => {
  assert.equal(historyPath('/tmp/x'), join('/tmp/x', 'history.jsonl'))
})

// ---------- readHistory ----------

test('readHistory：目录不存在 → 空数组（不抛）', () => {
  let out
  assert.doesNotThrow(() => { out = readHistory(dir('nope')) })
  assert.deepEqual(out, [])
})

test('readHistory：正常一行一事件，顺序保持', () => {
  const d = dir('good')
  mkdirSync(d, { recursive: true })
  writeFileSync(historyPath(d), [
    JSON.stringify({ id: 'e-1', ts: '2026-09-14T10:00:00.000Z', type: 'cycle', detail: '第 33 圈' }),
    JSON.stringify({ id: 'e-2', ts: '2026-09-14T11:00:00.000Z', type: 'verdict', detail: '', ref: 'h-1' }),
  ].join('\n') + '\n', 'utf-8')
  const out = readHistory(d)
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'cycle')
  assert.equal(out[1].ref, 'h-1')
})

test('退化：损坏行 / 空行 / 缺字段行 → 跳过，保留合法行（不抛）', () => {
  const d = dir('dirty')
  mkdirSync(d, { recursive: true })
  writeFileSync(historyPath(d), [
    '',
    '   ',
    '{"id":"e-1","ts":"2026-09-14T10:00:00.000Z","type":"cycle"}',
    '{"id":"torn","ts":"2026-09-14T10:0',            // torn tail
    '{"id":"no-type","ts":"2026-09-14T10:00:00.000Z"}', // 缺 type
    '{"id":"no-ts","type":"wire"}',                    // 缺 ts
    'null',
    '{"id":"e-2","ts":"2026-09-14T12:00:00.000Z","type":"note"}',
  ].join('\n'), 'utf-8')
  let out
  assert.doesNotThrow(() => { out = readHistory(d) })
  assert.deepEqual(out.map((e) => e.id), ['e-1', 'e-2'])
})

test('退化：history.jsonl 是目录（不可读）→ 空数组且不抛', () => {
  const d = dir('isdir')
  mkdirSync(historyPath(d), { recursive: true })
  let out
  assert.doesNotThrow(() => { out = readHistory(d) })
  assert.deepEqual(out, [])
})

// ---------- appendHistory ----------

test('appendHistory：成功写入一行，可被 readHistory 读回（往返一致）', () => {
  const d = dir('append')
  const now = new Date('2026-09-14T10:00:00.000Z')
  const r = appendHistory(d, { type: 'cycle', detail: '第 34 圈', ref: 'c-9' }, now)
  assert.notEqual(r, null)
  assert.equal(r.ts, '2026-09-14T10:00:00.000Z')
  assert.ok(r.id.startsWith('e-' + now.getTime().toString(36) + '-'))
  const back = readHistory(d)
  assert.equal(back.length, 1)
  assert.deepEqual(back[0], { id: r.id, ts: r.ts, type: 'cycle', detail: '第 34 圈', ref: 'c-9' })
})

test('appendHistory：detail/ref 缺省 → 写空串与 null（字段结构恒定）', () => {
  const d = dir('defaults')
  appendHistory(d, { type: 'note' }, new Date('2026-09-14T10:00:00.000Z'))
  const line = readFileSync(historyPath(d), 'utf-8').trim()
  assert.deepEqual(JSON.parse(line), {
    id: JSON.parse(line).id, ts: '2026-09-14T10:00:00.000Z', type: 'note', detail: '', ref: null,
  })
})

test('appendHistory：目录不存在 → 自动创建（mkdir recursive）', () => {
  const d = dir('auto/nested')
  const r = appendHistory(d, { type: 'cycle' }, new Date('2026-09-14T10:00:00.000Z'))
  assert.notEqual(r, null)
  assert.ok(existsSync(historyPath(d)))
})

test('写失败不抛：不可写路径（父路径是普通文件）→ 返回 null', () => {
  const blocker = join(root, 'blocker.txt')
  writeFileSync(blocker, 'not a dir', 'utf-8')
  let r
  assert.doesNotThrow(() => { r = appendHistory(join(blocker, 'sub'), { type: 'cycle' }) })
  assert.equal(r, null)
})

test('写失败不抛：事件体含循环引用（JSON.stringify 抛）→ 返回 null', () => {
  const circular = { type: 'cycle' }
  circular.detail = circular
  let r
  assert.doesNotThrow(() => { r = appendHistory(dir('circular'), circular) })
  assert.equal(r, null)
})

test('nextHistoryId：同毫秒连发不撞车（进程内自增）', () => {
  const ms = 1790000000000
  const a = nextHistoryId(ms)
  const b = nextHistoryId(ms)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('e-' + ms.toString(36) + '-'))
  assert.equal(Number(a.split('-').pop()) + 1, Number(b.split('-').pop()))
})

test('退化：appendHistory 连续追加两条（同 now）→ 两条都在，id 不同', () => {
  const d = dir('twice')
  const now = new Date('2026-09-14T10:00:00.000Z')
  const a = appendHistory(d, { type: 'cycle' }, now)
  const b = appendHistory(d, { type: 'verdict' }, now)
  assert.notEqual(a.id, b.id)
  const back = readHistory(d)
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((e) => e.ts), [now.toISOString(), now.toISOString()])
})
