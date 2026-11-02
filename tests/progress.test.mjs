/**
 * dsh-evolution-core — 推进读数回归测试（2026-11-02：自进化进 loop 的判据源）
 *
 * 这里测的是**判据本身**，不是渲染。理由（§3.4 结构纪律）：整套机制的价值全压在
 * 「什么叫推进」这一条定义上——它一旦松动（比如把 cycle 也算推进），
 * 读数会立刻变得漂亮而毫无意义，且**这种失效不会报错**。
 * 所以把它钉成离线可证伪的断言。
 *
 * 运行：node --test tests/progress.test.mjs（需先 npm run build）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeProgress, renderProgressLine, ADVANCE_TYPES, NEEDS_EVIDENCE,
} from '../lib/core.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString()
const ev = (type, h, extra = {}) => ({ id: 'e-' + type + '-' + h, ts: hoursAgo(h), type, detail: '', ref: null, ...extra })

// ---------- 什么算推进（整套机制的地基） ----------

test('ADVANCE_TYPES：只有改东西的五类算推进，cycle/note/checkpoint 不算', () => {
  for (const t of ['verdict', 'forge', 'wire', 'evolve', 'reflect']) {
    assert.equal(ADVANCE_TYPES.has(t), true, `${t} 应当算推进`)
  }
  for (const t of ['cycle', 'note', 'checkpoint']) {
    assert.equal(ADVANCE_TYPES.has(t), false, `${t} 不应当算推进`)
  }
})

test('NEEDS_EVIDENCE：裁决/炼化/布线要证据；reflect 与 evolve 不用（证据另有载体）', () => {
  for (const t of ['verdict', 'forge', 'wire']) assert.equal(NEEDS_EVIDENCE.has(t), true)
  for (const t of ['reflect', 'evolve', 'cycle', 'note', 'checkpoint']) assert.equal(NEEDS_EVIDENCE.has(t), false)
})

test('★ 只有 cycle 的一天：advanceTotal 必须为 0（「我来过」不是「我推进了」）', () => {
  const events = [ev('cycle', 1), ev('cycle', 4), ev('cycle', 7), ev('cycle', 10)]
  const p = computeProgress(events, NOW, 12)
  assert.equal(p.advanceTotal, 0, '16 圈全记 cycle 也一次推进都没有')
  assert.equal(p.lastAdvanceAt, null)
  assert.equal(p.hoursSinceAdvance, null)
})

test('note 与 checkpoint 同样不计入推进（保存现场 ≠ 改进现场）', () => {
  const p = computeProgress([ev('note', 1), ev('checkpoint', 2), ev('cycle', 3)], NOW, 12)
  assert.equal(p.advanceTotal, 0)
})

// ---------- stale：该不该动 ----------

test('从未推进过也算 stale（否则新装插件永远等下去）', () => {
  const p = computeProgress([], NOW, 12)
  assert.equal(p.stale, true)
  assert.equal(p.advanceTotal, 0)
})

test('刚推进过 ⇒ 不 stale', () => {
  const p = computeProgress([ev('wire', 1)], NOW, 12)
  assert.equal(p.stale, false)
  assert.equal(p.hoursSinceAdvance, 1)
})

test('超过阈值 ⇒ stale（边界：恰好等于阈值也算）', () => {
  assert.equal(computeProgress([ev('wire', 11.9)], NOW, 12).stale, false)
  assert.equal(computeProgress([ev('wire', 12)], NOW, 12).stale, true)
  assert.equal(computeProgress([ev('wire', 30)], NOW, 12).stale, true)
})

test('最近一次推进取**最新**那条，不是最早', () => {
  const p = computeProgress([ev('wire', 30), ev('verdict', 2), ev('forge', 20)], NOW, 12)
  assert.equal(p.hoursSinceAdvance, 2)
  assert.equal(p.stale, false)
})

test('hoursSinceAdvance 四舍五入到 0.1（避免 3.0000000000000004 这种读数）', () => {
  const p = computeProgress([{ id: 'x', ts: new Date(NOW.getTime() - 3.333333 * 3600000).toISOString(), type: 'wire' }], NOW, 12)
  assert.equal(p.hoursSinceAdvance, 3.3)
})

// ---------- creditlessStreak：动了算不算数 ----------

test('推进没带 evidence ⇒ creditlessStreak 累加', () => {
  const p = computeProgress([ev('wire', 1), ev('verdict', 2), ev('forge', 3)], NOW, 12)
  assert.equal(p.creditlessStreak, 3)
  assert.equal(p.creditedTotal, 0)
})

test('遇到带证据的条就停（只数**最近连续**的无证据段）', () => {
  const events = [
    ev('wire', 1),                                  // 无证据
    ev('verdict', 2),                               // 无证据
    ev('forge', 3, { evidence: 'AGENTS.md:207' }),  // 有证据 ⇒ 停
    ev('wire', 4),                                  // 更早的无证据，不计入 streak
  ]
  const p = computeProgress(events, NOW, 12)
  assert.equal(p.creditlessStreak, 2)
  assert.equal(p.creditedTotal, 1)
})

test('非推进类型出现在中间**不打断**计数（cycle 夹在两条无证据之间）', () => {
  const p = computeProgress([ev('wire', 1), ev('cycle', 2), ev('verdict', 3)], NOW, 12)
  assert.equal(p.creditlessStreak, 2, 'cycle 不属推进，不该把 streak 打断')
})

test('不需要证据的类型（reflect / evolve）不参与 streak 也不打断', () => {
  const p = computeProgress([ev('wire', 1), ev('reflect', 2), ev('wire', 3)], NOW, 12)
  assert.equal(p.creditlessStreak, 2)
})

test('白字符串证据视同没给（trim 后为空）', () => {
  const p = computeProgress([ev('wire', 1, { evidence: '   ' })], NOW, 12)
  assert.equal(p.creditlessStreak, 1)
  assert.equal(p.creditedTotal, 0)
})

// ---------- 7 天窗口 ----------

test('advanceCount7d 只数 7 天内（第 8 天的不算）', () => {
  const p = computeProgress([ev('wire', 24 * 6), ev('wire', 24 * 8), ev('wire', 24 * 20)], NOW, 12)
  assert.equal(p.advanceCount7d, 1)
  assert.equal(p.advanceTotal, 3, '窗口外的不进 7 天计数，但仍进累计')
})

test('★ creditlessStreak 也只数 7 天内（上线首日实测 286 是错的读数）', () => {
  // 尸体样本：2026-11-02 首次上线时「连续 286 条无证据」把 30 天以前的老记录全算了进来，
  // 读起来像「最近连做 286 次都没带证据」。窗口外的一律不进 streak。
  const events = [
    ev('wire', 24 * 1),    // 窗口内，无证据 ⇒ 计入
    ev('forge', 24 * 2),   // 窗口内，无证据 ⇒ 计入
    ev('verdict', 24 * 20),// 窗口外 ⇒ 停
    ev('wire', 24 * 40),   // 更早，不该被数到
  ]
  const p = computeProgress(events, NOW, 12)
  assert.equal(p.creditlessStreak, 2, '只有 7 天内的两条该被数进 streak')
  assert.equal(p.advanceTotal, 4, '累计仍是全量')
})

test('7 天内全带证据 ⇒ streak 0', () => {
  const p = computeProgress([ev('wire', 1, { evidence: 'a.ts:1' }), ev('verdict', 2, { evidence: 'mem-x' })], NOW, 12)
  assert.equal(p.creditlessStreak, 0)
  assert.equal(p.creditedTotal, 2)
})

// ---------- 渲染（口径单一，两处共用） ----------

test('renderProgressLine：从未推进 / 正常 / stale 三态文案', () => {
  const none = renderProgressLine(computeProgress([], NOW, 12))
  assert.match(none, /从未推进/)

  const fresh = renderProgressLine(computeProgress([ev('wire', 1)], NOW, 12))
  assert.match(fresh, /1h 前推进/)
  assert.match(fresh, /正常/)

  const stale = renderProgressLine(computeProgress([ev('wire', 30)], NOW, 12))
  assert.match(stale, /本圈必须推进/)
})

test('renderProgressLine：有连续无证据时把它念出来（让「动了不算数」显形）', () => {
  const line = renderProgressLine(computeProgress([ev('wire', 1), ev('verdict', 2)], NOW, 12))
  assert.match(line, /连续 2 条无证据/)
})
