/**
 * dsh-evolution-core — format.ts 回归测试（呈现/格式化纯层）
 * 运行：node --test tests/format.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TYPE_LABEL, renderOrganLine, ringMark, clampDays, hasRedRing } from '../lib/format.js'

// ---------- TYPE_LABEL ----------

test('TYPE_LABEL：8 个动作类型的中文标签逐字锁定', () => {
  assert.deepEqual(TYPE_LABEL, {
    cycle: '感知圈', verdict: '裁决', forge: '炼化', evolve: '评测',
    wire: '布线', reflect: '反思', checkpoint: '存档', note: '备注',
  })
})

// ---------- renderOrganLine ----------

test('renderOrganLine：7 个器官的真实格式（含真实常数）', () => {
  assert.equal(renderOrganLine('selftest', { ok: true, total: 6, active: 2, finding: 1, confirmed: 1, refuted: 2 }),
    'selftest: 共6 活跃2 finding1 ✓1 ✗2')
  assert.equal(renderOrganLine('emotion', { ok: true, today: '2026-09-14', triggerCount: 7, statsKeys: ['a', 'b', 'c'] }),
    'emotion: today=2026-09-14 触发7次 工具3种')
  assert.equal(renderOrganLine('reflection', { ok: true, lastTriggerDate: '2026-09-14', triggerCount: 3 }),
    'reflection: 上次2026-09-14 共3次')
  assert.equal(renderOrganLine('lifeCore', { ok: true, status: 'active', todayTurns: 5, cycleMinutes: 30 }),
    'life-core: active 今日5圈 周期30min')
  assert.equal(renderOrganLine('memory', { ok: true, entryCount: 153 }), 'memory: 条目153')
  assert.equal(renderOrganLine('checkpoints', { ok: true, count: 12, latest: '20260914-101010-abcdef', latestAgeDays: 1 }),
    'checkpoints: 12个 最近20260914-101010-abcdef（1天前）')
  assert.equal(renderOrganLine('evolve', { ok: true, generationCount: 8, lastGenAt: '2026-09-07T00:00:00.000Z', idleDays: 7 }),
    'evolve: 8代 最近2026-09-07 闲置7天')
})

test('renderOrganLine：ok=false → 统一「⚠不可读」', () => {
  assert.equal(renderOrganLine('selftest', { ok: false, error: 'self-test.json 不可读' }), 'selftest: ⚠不可读')
  assert.equal(renderOrganLine('checkpoints', { ok: false }), 'checkpoints: ⚠不可读')
})

test('renderOrganLine：未知器官键 → JSON 兜底（不吞掉信息）', () => {
  assert.equal(renderOrganLine('foo', { ok: true, a: 1 }), 'foo: {"ok":true,"a":1}')
})

test('退化：renderOrganLine 缺字段 → 不抛（显示 undefined 原值，不静默补数）', () => {
  const cases = [
    ['selftest', { ok: true }],
    ['emotion', { ok: true }],
    ['reflection', { ok: true }],
    ['lifeCore', { ok: true }],
    ['memory', { ok: true }],
    ['checkpoints', { ok: true }],
    ['evolve', { ok: true }],
    ['foo', {}],
  ]
  for (const [key, o] of cases) {
    assert.doesNotThrow(() => renderOrganLine(key, o), `${key} 不应抛`)
    assert.equal(typeof renderOrganLine(key, o), 'string')
  }
  assert.equal(renderOrganLine('memory', { ok: true }), 'memory: 条目undefined')
  assert.equal(renderOrganLine('evolve', { ok: true }), 'evolve: undefined代 最近— 闲置?天')
})

test('已登记缺口 L2（本次未改行为）：null/undefined 快照读 o.ok 会抛——调用点必须判空', () => {
  // 现状锁定：renderOrganLine 直接读 o.ok。两个调用点均在外部判空
  // （aggregateSnapshot 用 `organ === undefined ? '⚠不可读' : ...`；工具 render 的 organs 来自 JSON 载荷恒为对象）。
  // 从调用点移除判空即会把这里变成线上崩溃——本断言就是那道护栏的哨兵。
  assert.throws(() => renderOrganLine('selftest', null), TypeError)
  assert.throws(() => renderOrganLine('selftest', undefined), TypeError)
})

// ---------- ringMark ----------

test('ringMark：四态映射 + 未知态 → 白点', () => {
  assert.equal(ringMark('green'), '🟢')
  assert.equal(ringMark('yellow'), '🟡')
  assert.equal(ringMark('red'), '🔴')
  assert.equal(ringMark('unknown'), '⚪')
  assert.equal(ringMark(undefined), '⚪')
})

// ---------- clampDays ----------

test('clampDays：缺省 30，收敛到 [1, 3650]（真实边界）', () => {
  assert.equal(clampDays(undefined), 30)
  assert.equal(clampDays(1), 1)
  assert.equal(clampDays(0), 1)
  assert.equal(clampDays(-5), 1)
  assert.equal(clampDays(30), 30)
  assert.equal(clampDays(3650), 3650)
  assert.equal(clampDays(3651), 3650)
  assert.equal(clampDays(1e9), 3650)
})

test('退化：clampDays 喂 NaN / 非数 → 不抛（沿用原行为：NaN 透传，不作数）', () => {
  assert.doesNotThrow(() => clampDays(NaN))
  assert.ok(Number.isNaN(clampDays(NaN)))
  assert.doesNotThrow(() => clampDays('30'))
  assert.equal(clampDays(null), 30) // null ?? 30 → 30（与 undefined 同路径）
})

// ---------- hasRedRing ----------

test('hasRedRing：空环/全绿/未知态为 false，任一红为 true', () => {
  assert.equal(hasRedRing([]), false)
  assert.equal(hasRedRing([{ state: 'green' }, { state: 'yellow' }]), false)
  assert.equal(hasRedRing([{ state: 'green' }, { state: 'red' }]), true)
  assert.equal(hasRedRing([{ state: 'unknown' }]), false)
})

test('退化：hasRedRing 喂缺 state 的脏环项 → 不抛且按非红处理（保守）', () => {
  assert.equal(hasRedRing([{}, { state: null }]), false)
  assert.equal(hasRedRing([{ state: 'red' }, {}]), true)
})

test('已登记缺口 L3（本次未改行为）：环项为 null 会抛——环数组恒由 diagnoseRings 产出', () => {
  assert.throws(() => hasRedRing([null]), TypeError)
})
