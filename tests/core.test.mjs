/**
 * dsh-evolution-core — core.ts 回归测试（五环诊断 / 建议 / 履历统计 / 器官容错解析）
 * 运行：node --test tests/core.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  localDay, daysBetween, summarizeSelftest, summarizeEmotion, summarizeReflection,
  summarizeLifeCore, summarizeEvolve, summarizeMemory, summarizeCheckpoints,
  diagnoseRings, buildSuggestions, computeHistoryStats, buildSummary,
} from '../lib/core.js'

const ring = (rings, name) => rings.find((r) => r.name === name)
const selftest = (over = {}) => ({ ok: true, active: 2, finding: 0, confirmed: 2, refuted: 3, activeWithEvidence: true, ...over })

// ---------- 工具函数 ----------

test('localDay：本地日期补零（1 月 5 日 → 2026-01-05）', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 8, 0, 0)), '2026-01-05')
  assert.equal(localDay(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31')
})

test('daysBetween：真实差值 + 未来回零 + 非法输入 null（不抛）', () => {
  const now = new Date(2026, 8, 14, 12, 0, 0)
  assert.equal(daysBetween(new Date(now.getTime() - 3 * 86400000).toISOString(), now), 3)
  assert.equal(daysBetween(new Date(now.getTime() + 5 * 86400000).toISOString(), now), 0) // 未来 → clamp 0
  assert.equal(daysBetween(undefined, now), null)
  assert.equal(daysBetween('', now), null)
  assert.equal(daysBetween('not-a-date', now), null)
})

// ---------- 器官快照：主路径 ----------

test('summarizeSelftest：真实常数分类计数 + activeWithEvidence + 最新更新时间', () => {
  const raw = {
    hypotheses: [
      { status: 'active', evidence: [{ at: 1 }], updatedAt: '2026-09-10T00:00:00Z' },
      { status: 'active', evidence: [] },
      { status: 'finding' },
      { status: 'confirmed' },
      { status: 'refuted' },
      { status: 'refuted' },
    ],
  }
  const s = summarizeSelftest(raw)
  assert.equal(s.ok, true)
  assert.equal(s.total, 6)
  assert.equal(s.active, 2)
  assert.equal(s.finding, 1)
  assert.equal(s.confirmed, 1)
  assert.equal(s.refuted, 2)
  assert.equal(s.activeWithEvidence, true)
  assert.equal(s.latestUpdatedAt, '2026-09-10T00:00:00Z')
})

test('summarizeSelftest：active 全无证据 → activeWithEvidence=false（探针未命中信号）', () => {
  const s = summarizeSelftest({ hypotheses: [{ status: 'active', evidence: [] }] })
  assert.equal(s.active, 1)
  assert.equal(s.activeWithEvidence, false)
})

// ★ 自指闭环**真源**（2026-10-18 新增）：最新一条普通 confirmed 的 updatedAt。
//   关键纪律：**必须排除 enabling** —— 使能型声明兑现后也是 confirmed，但那是「依赖路径兑现」不是「布线」，
//   计入会让读数比实际新（**假活**），而这一面存在的理由正是抓假活。
//   同源纪律见 dsh-agent-self-rewrite/src/status.ts:186（两插件读同一个 self-test.json ⇒ 判据必须一致）。
test('★ summarizeSelftest·latestConfirmedAt：取最新普通 confirmed；enabling 兑现的**不计入**', () => {
  const s = summarizeSelftest({
    hypotheses: [
      { status: 'confirmed', updatedAt: '2026-09-20T16:10:27.000Z' },
      { status: 'confirmed', updatedAt: '2026-09-18T02:53:47.000Z' },
      // 使能型声明兑现：updatedAt **最新**，但不得进入 latestConfirmedAt
      { status: 'confirmed', enabling: ['后续动作 A'], updatedAt: '2026-10-17T23:00:00.000Z' },
      { status: 'refuted', updatedAt: '2026-10-01T00:00:00.000Z' },
      { status: 'active', updatedAt: '2026-10-17T23:59:00.000Z' },
    ],
  })
  assert.equal(s.latestConfirmedAt, '2026-09-20T16:10:27.000Z')
  // 对照：latestUpdatedAt（**不**过滤状态与 enabling）被最新那条 active 刷新 ——
  // 两个量语义不同（「最后有任何动静」vs「最后布线」），混用就是又一次假活。
  assert.equal(s.latestUpdatedAt, '2026-10-17T23:59:00.000Z')
})

test('★ summarizeSelftest·latestConfirmedAt 边界：无 confirmed / 空串 / 非法日期 → null（不是 0）', () => {
  assert.equal(summarizeSelftest({ hypotheses: [{ status: 'active' }] }).latestConfirmedAt, null)
  assert.equal(summarizeSelftest({ hypotheses: [] }).latestConfirmedAt, null)
  assert.equal(summarizeSelftest({}).latestConfirmedAt, null)
  assert.equal(summarizeSelftest({ hypotheses: [{ status: 'confirmed', updatedAt: '' }] }).latestConfirmedAt, null)
  assert.equal(summarizeSelftest({ hypotheses: [{ status: 'confirmed', updatedAt: 'not-a-date' }] }).latestConfirmedAt, null)
})

test('summarizeEvolve：代际计数 + 闲置天数（now 注入）', () => {
  const raw = { initialized: true, generations: [{ at: '2026-09-01T00:00:00.000Z' }, { at: '2026-09-07T00:00:00.000Z' }], active: { g8: 'A96' } }
  const s = summarizeEvolve(raw, new Date('2026-09-14T00:00:00.000Z'))
  assert.equal(s.generationCount, 2)
  assert.equal(s.lastGenAt, '2026-09-07T00:00:00.000Z')
  assert.equal(s.idleDays, 7) // 边界：恰好 7 天 → 7（不因浮点掉到 6）
  assert.deepEqual(s.activeVersion, { g8: 'A96' })
})

test('summarizeMemory：entries 对象键数 / 数组长度 / 缺失 → 0', () => {
  assert.equal(summarizeMemory({ tables: { entries: { a: 1, b: 2 } } }).entryCount, 2)
  assert.equal(summarizeMemory({ tables: { entries: [1, 2, 3] } }).entryCount, 3)
  assert.equal(summarizeMemory({ tables: {} }).entryCount, 0)
  assert.deepEqual(summarizeMemory({ unit: { u1: {} }, global: { g1: {} } }).unitKeys, ['u1'])
})

test('summarizeCheckpoints：字典序取最新 + 目录名解析 + 空列表', () => {
  const names = ['20260903-093458-295a1f', '20260901-010101-aaaaaa', '20260904-120000-bbbbbb']
  const s = summarizeCheckpoints(names, new Date(2026, 8, 4, 12, 0, 0))
  assert.equal(s.count, 3)
  assert.equal(s.latest, '20260904-120000-bbbbbb') // 字典序 = 时间序
  assert.equal(s.latestAgeDays, 0)
  const empty = summarizeCheckpoints([], new Date(2026, 8, 4))
  assert.equal(empty.count, 0)
  assert.equal(empty.latest, null)
  assert.equal(empty.latestAgeDays, null)
})

test('summarizeCheckpoints：边界——恰好 1 天 = 1；少 1 秒 = 0', () => {
  const t = new Date(2026, 8, 3, 9, 34, 58)
  assert.equal(summarizeCheckpoints(['20260903-093458-295a1f'], new Date(t.getTime() + 86400000)).latestAgeDays, 1)
  assert.equal(summarizeCheckpoints(['20260903-093458-295a1f'], new Date(t.getTime() + 86400000 - 1000)).latestAgeDays, 0)
})

// ---------- 器官快照：退化/脏数据必须不抛 ----------

test('退化：7 个 summarize* 喂 null/undefined/数组/字符串 → 不抛且 ok=true 兜底', () => {
  const now = new Date(2026, 8, 14)
  const cases = [null, undefined, [], 'garbage', 42, {}]
  for (const raw of cases) {
    assert.doesNotThrow(() => summarizeSelftest(raw))
    assert.doesNotThrow(() => summarizeEmotion(raw))
    assert.doesNotThrow(() => summarizeReflection(raw))
    assert.doesNotThrow(() => summarizeLifeCore(raw))
    assert.doesNotThrow(() => summarizeEvolve(raw, now))
    assert.doesNotThrow(() => summarizeMemory(raw))
    assert.equal(summarizeSelftest(raw).ok, true)
    assert.equal(summarizeSelftest(raw).total, 0)
    assert.equal(summarizeEvolve(raw, now).idleDays, null)
    assert.equal(summarizeMemory(raw).entryCount, 0)
    assert.deepEqual(summarizeEmotion(raw).statsKeys, [])
  }
})

test('退化：hypotheses/generations 非数组（脏类型）→ 不抛、按空处理', () => {
  assert.equal(summarizeSelftest({ hypotheses: 'nope' }).total, 0)
  assert.equal(summarizeEvolve({ generations: 'nope' }, new Date()).generationCount, 0)
  assert.equal(summarizeEvolve({ generations: [null, { at: 123 }] }, new Date()).lastGenAt, null)
})

test('退化：数值字段脏（字符串/NaN/Infinity）→ 不抛，非法数回 0', () => {
  assert.equal(summarizeEmotion({ triggerCount: '5' }).triggerCount, 0)
  assert.equal(summarizeEmotion({ triggerCount: NaN }).triggerCount, 0)
  assert.equal(summarizeLifeCore({ todayTurns: Infinity }).todayTurns, 0)
  assert.equal(summarizeReflection({ triggerCount: 7 }).triggerCount, 7)
})

test('退化：checkpoints 脏目录名 → latestAgeDays=null 且不抛', () => {
  const s = summarizeCheckpoints(['garbage-name', '2026-bad'], new Date(2026, 8, 14))
  assert.equal(s.latest, 'garbage-name')
  assert.equal(s.latestAgeDays, null)
})

// ---------- 五环诊断 ----------

test('五环诊断：全绿样本（active 2 / 有证据 / 无 finding / 5 次裁决 / 7 天前闭环）', () => {
  const { rings, broken } = diagnoseRings({ selftest: selftest(), lastConfirmedDays: 7 })
  assert.equal(rings.length, 5)
  assert.deepEqual(rings.map((r) => r.state), ['green', 'green', 'green', 'green', 'green'])
  assert.deepEqual(broken, [])
  assert.equal(ring(rings, 'hypothesize').detail, '2 条检验中猜想')
  assert.equal(ring(rings, 'wire').detail, '自指闭环 7 天前合上')
})

test('五环诊断：数据源不可读 → 前四环 yellow（不误报红）+ 布线环独立判定', () => {
  const { rings, broken } = diagnoseRings({ selftest: { ok: false, error: 'x' }, lastConfirmedDays: 1 })
  assert.deepEqual(rings.map((r) => r.state), ['yellow', 'yellow', 'yellow', 'yellow', 'green'])
  for (const r of rings.slice(0, 4)) assert.equal(r.detail, '数据源不可读')
  assert.deepEqual(broken, [])
})

test('五环诊断·猜想环边界：active=2 绿 / 1 黄 / 0 且有终态=空窗黄（不列断点）/ 库全空=红+断点', () => {
  assert.equal(ring(diagnoseRings({ selftest: selftest({ active: 2 }), lastConfirmedDays: 1 }).rings, 'hypothesize').state, 'green')
  assert.equal(ring(diagnoseRings({ selftest: selftest({ active: 1 }), lastConfirmedDays: 1 }).rings, 'hypothesize').state, 'yellow')
  // 空窗（2026-09-21）：库里有终态假设 ⇒ active=0 是**收敛态**，不是断点（不列入 broken、不催补假设）
  const empty = diagnoseRings({ selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 3, refuted: 5 }), lastConfirmedDays: 1 })
  assert.equal(ring(empty.rings, 'hypothesize').state, 'yellow')
  assert.match(ring(empty.rings, 'hypothesize').detail, /空窗/)
  assert.equal(empty.broken.some((b) => b.ring === 'hypothesize'), false)
  // 真断点：库里既无 active 也无终态
  const none = diagnoseRings({ selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 0, refuted: 0 }), lastConfirmedDays: 1 })
  assert.equal(ring(none.rings, 'hypothesize').state, 'red')
  assert.match(none.broken[0].signal, /库为空/)
})

test('五环诊断·采证环边界：有证据绿 / 无证据黄 / 空窗黄 / 库空红+断点', () => {
  assert.equal(ring(diagnoseRings({ selftest: selftest({ active: 2, activeWithEvidence: true }), lastConfirmedDays: 1 }).rings, 'evidence').state, 'green')
  assert.equal(ring(diagnoseRings({ selftest: selftest({ active: 2, activeWithEvidence: false }), lastConfirmedDays: 1 }).rings, 'evidence').state, 'yellow')
  const empty = diagnoseRings({ selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 3, refuted: 5 }), lastConfirmedDays: 1 })
  assert.equal(ring(empty.rings, 'evidence').state, 'yellow')
  assert.match(ring(empty.rings, 'evidence').detail, /空窗/)
  const none = diagnoseRings({ selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 0, refuted: 0 }), lastConfirmedDays: 1 })
  assert.equal(ring(none.rings, 'evidence').state, 'red')
  // 入列顺序：猜想先于采证（裁决环此时也会红——库空 ⇒ 无终态，属预期）
  assert.deepEqual(none.broken.map((b) => b.ring).slice(0, 2), ['hypothesize', 'evidence'])
})

test('五环诊断·finding 环边界：0 绿 / 1 红+断点（积压即红）', () => {
  assert.equal(ring(diagnoseRings({ selftest: selftest({ finding: 0 }), lastConfirmedDays: 1 }).rings, 'finding').state, 'green')
  const r = diagnoseRings({ selftest: selftest({ finding: 1 }), lastConfirmedDays: 1 })
  assert.equal(ring(r.rings, 'finding').state, 'red')
  assert.equal(r.broken[0].signal, 'finding 积压 = 1')
})

test('五环诊断·裁决环边界：≥5 绿 / 1-4 黄 / 0 红+断点', () => {
  assert.equal(ring(diagnoseRings({ selftest: selftest({ confirmed: 3, refuted: 2 }), lastConfirmedDays: 1 }).rings, 'verdict').state, 'green')
  assert.equal(ring(diagnoseRings({ selftest: selftest({ confirmed: 2, refuted: 2 }), lastConfirmedDays: 1 }).rings, 'verdict').state, 'yellow')
  assert.equal(ring(diagnoseRings({ selftest: selftest({ confirmed: 1, refuted: 0 }), lastConfirmedDays: 1 }).rings, 'verdict').state, 'yellow')
  const r = diagnoseRings({ selftest: selftest({ confirmed: 0, refuted: 0 }), lastConfirmedDays: 1 })
  assert.equal(ring(r.rings, 'verdict').state, 'red')
  assert.equal(r.broken[0].signal, 'confirmed+refuted = 0')
})

test('五环诊断·布线环边界（真源=自指闭环）：null 红 / 0-7 绿 / 8-14 黄 / 15-30 黄（文件也静）/ 31 红+断点', () => {
  const wire = (d, fileDays) => ring(diagnoseRings({ selftest: selftest(), lastConfirmedDays: d, fileActivityDays: fileDays }).rings, 'wire').state
  assert.equal(wire(null), 'red')
  assert.equal(wire(0), 'green')
  assert.equal(wire(7), 'green')
  assert.equal(wire(8), 'yellow')
  assert.equal(wire(14), 'yellow')
  assert.equal(wire(15), 'yellow') // 偏久但**文件也静** ⇒ 黄，不是红（见下面对照组）
  assert.equal(wire(30), 'yellow')
  assert.equal(wire(31), 'red')
  const r = diagnoseRings({ selftest: selftest(), lastConfirmedDays: null })
  assert.equal(r.broken[0].ring, 'wire')
})

// ★ 尸体样本（2026-10-18 当晚**真实读数**的形状）：代理量新鲜 ∧ 真源停摆 ⇒ **必须红**。
//   旧判据（技能目录 mtime）在这里判绿 —— 而当晚正是「环 🟢 而自指闭环停 27 天」。
//   Proxy Drift（arXiv:2610.21646 §7）：代理量升、真量停，**无对手、无自指**，
//   纯粹因为「任何技能文件写入都让 mtime 变新」（同步镜像 / 改错别字 / 编辑技能全都算）。
test('★ 尸体·Proxy Drift：文件在动而自指闭环停摆 ⇒ 红 + 背离断点；对照组（文件也静）⇒ 黄', () => {
  const drift = diagnoseRings({ selftest: selftest(), lastConfirmedDays: 27, fileActivityDays: 0 })
  assert.equal(ring(drift.rings, 'wire').state, 'red')
  assert.match(ring(drift.rings, 'wire').detail, /代理量背离/)
  assert.equal(drift.broken.length, 1)
  assert.match(drift.broken[0].signal, /代理量背离/)
  // 对照组：同样 27 天，但文件也静（20 天前）⇒ **黄**。
  // 无此对照，上一条证明不了判据测的是「背离」而不是「27 天」。
  const ctrl = diagnoseRings({ selftest: selftest(), lastConfirmedDays: 27, fileActivityDays: 20 })
  assert.equal(ring(ctrl.rings, 'wire').state, 'yellow')
  assert.deepEqual(ctrl.broken, [])
})

// ★ 恢复样本：闭环重新合上 ⇒ 必须回绿。恒红与恒绿都不是判据。
test('★ 恢复：自指闭环 3 天前合上（文件 0 天前在动）⇒ 绿', () => {
  assert.equal(ring(diagnoseRings({ selftest: selftest(), lastConfirmedDays: 3, fileActivityDays: 0 }).rings, 'wire').state, 'green')
})

// 阈值参数化（原「半死参数」wireFreshDays，语义文档 U3）：改配置**真的**改判定
test('布线阈值参数化：wireFreshDays=3 ⇒ 5 天即黄；wireFreshDays=20 ⇒ 5 天仍绿', () => {
  const st = (d, fresh) => ring(diagnoseRings({ selftest: selftest(), lastConfirmedDays: d, wireFreshDays: fresh }).rings, 'wire').state
  assert.equal(st(5, 3), 'yellow')
  assert.equal(st(5, 20), 'green')
  assert.equal(st(5, undefined), 'green') // 缺省 7
})

test('退化：selftest 字段脏（active 是字符串）→ 不抛，按 0 判定（保守为红）', () => {
  const r = diagnoseRings({ selftest: { ok: true, active: '3', finding: null, confirmed: 'x', refuted: 0 }, lastConfirmedDays: 3 })
  assert.doesNotThrow(() => r)
  assert.equal(ring(r.rings, 'hypothesize').state, 'red')
})

test('退化：diagnoseRings 空入参（无 selftest、无布线记录）→ 不抛且给满 5 环', () => {
  let out
  assert.doesNotThrow(() => { out = diagnoseRings({ lastConfirmedDays: null }) })
  assert.equal(out.rings.length, 5)
  assert.equal(out.broken.length, 1) // 仅布线环有断点（selftest 不可读时前四环只判黄，不误报红）
})

// ---------- 建议生成 ----------

test('buildSuggestions：全健康 → 五环健康兜底建议（唯一一条）', () => {
  const out = buildSuggestions({
    selftest: selftest(),
    evolve: { ok: true, idleDays: 3 },
    checkpoints: { ok: true, latestAgeDays: 1, latest: 'x' },
    lastConfirmedDays: 2,
  })
  assert.deepEqual(out, ['五环健康：考虑下一轮进化——技能炼化（skill_signals/skill_extract 找候选）、新猜想（selftest_add）、或评测轮（evolve）'])
})

test('buildSuggestions：不可读器官置顶且按 selftest/evolve/checkpoints 顺序列出', () => {
  const out = buildSuggestions({ selftest: { ok: false }, evolve: { ok: false }, checkpoints: { ok: false }, lastConfirmedDays: 1 })
  assert.equal(out[0], '⚠ 器官数据源不可读：selftest/evolve/checkpoints——检查文件路径与格式（只读读取器容错返回，需人工核对）')
})

test('buildSuggestions：finding 积压 → 裁决建议（优先级仅次于不可读）', () => {
  const out = buildSuggestions({ selftest: selftest({ finding: 3 }), evolve: { ok: true, idleDays: 1 }, checkpoints: { ok: true, latestAgeDays: 0 }, lastConfirmedDays: 1 })
  assert.deepEqual(out, ['【裁决】有 3 条 finding 待裁决：selftest_review（confirm 布线 / refute 淘汰 / refine 细化）'])
})

test('buildSuggestions·评测边界：>14 红建议 / 14 走黄建议 / 7 不提示 / 8 走黄建议', () => {
  const run = (idleDays) => buildSuggestions({ selftest: selftest(), evolve: { ok: true, idleDays }, checkpoints: { ok: true, latestAgeDays: 0 }, lastConfirmedDays: 1 })
  // ★ 2026-10-15：主人重申「别跑进化轮了，收益不高，基准太旧」⇒ 建议文案必须**把「最小探测」与「完整轮」分开**
  //   （否则它会把人推去 spawn/submit —— 实测：我探测完顺手跑了整轮，正是这个形状）。
  assert.deepEqual(run(15), ['【评测】evolve 已闲置 15 天（>14 红）：⚠ **完整评测轮已由主人暂停**（09-20 定调 / 10-15 重申：收益不高、基准太旧）⇒ **不要 spawn/submit**；只做**最小探测**（一次 start 即可定性仪器死活）；真要跑整轮**先问主人**'])
  assert.deepEqual(run(14), ['【评测】evolve 闲置 14 天（>7 黄）：完整评测轮**已暂停**（主人 09-20/10-15）⇒ **不 spawn/submit**；可做**最小探测**（一次 start）'])
  assert.deepEqual(run(8), ['【评测】evolve 闲置 8 天（>7 黄）：完整评测轮**已暂停**（主人 09-20/10-15）⇒ **不 spawn/submit**；可做**最小探测**（一次 start）'])
  assert.equal(run(7).some((s) => s.includes('【评测】')), false)
  // 尸体：两档**必须不同**（红档更强，含「先问主人」）—— 若把两档写成同一句，这条会红
  assert.notEqual(run(15)[0], run(8)[0], '★ 红/黄两档不得合并成同一句（否则阈值失去区分力）')
})

test('buildSuggestions·猜想/采证三分：库空→补猜想；空窗→劝住手（写明门槛）；有 active 无证据→采证', () => {
  const base = { evolve: { ok: true, idleDays: 1 }, checkpoints: { ok: true, latestAgeDays: 0 }, lastConfirmedDays: 1 }
  assert.deepEqual(buildSuggestions({ ...base, selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 0, refuted: 0 }) }),
    ['【猜想】无检验中猜想：selftest_add 一条可证伪自我假设（statement + prediction + probe）'])
  // 空窗（2026-09-21）：有终态记录 ⇒ 不催补假设，改为提醒门槛（防 Goodhart：为点亮环而造假设）
  const empty = buildSuggestions({ ...base, selftest: selftest({ active: 0, activeWithEvidence: false, confirmed: 3, refuted: 5 }) })
  assert.equal(empty.length, 1)
  assert.match(empty[0], /^【猜想】空窗（8 条已终态/)
  assert.match(empty[0], /不要为点亮该环而新增假设/)
  assert.equal(empty.some((l) => /selftest_add 一条可证伪/.test(l)), false)
  assert.deepEqual(buildSuggestions({ ...base, selftest: selftest({ active: 2, activeWithEvidence: false }) }),
    ['【采证】有 active 假设但证据 0：检查探针配置是否合理（tool 名/阈值/窗口），或确认行为确实未触发'])
})

test('buildSuggestions·布线/存档边界：闭环 >7 天才提示布线；>3 天才提示存档；背离时加警告', () => {
  const run = (lastConfirmedDays, cpAge, fileActivityDays) => buildSuggestions({ selftest: selftest(), evolve: { ok: true, idleDays: 1 }, checkpoints: { ok: true, latestAgeDays: cpAge, latest: '20260901-010101-aaaaaa' }, lastConfirmedDays, fileActivityDays })
  assert.deepEqual(run(8, 4), [
    '【布线】自指闭环 8 天未合上（阈值 7 天）：查 rewrite_status 停滞读数（在采证 0 条 ⇒ 采证链断）后推进，或**明确记录本季收敛**（无意识停摆 ≠ 有意识收敛）',
    '【存档】4 天未存档（最近 20260901-010101-aaaaaa）：checkpoint_create 存档点（保活+试错回滚）',
  ])
  assert.deepEqual(run(7, 3), ['五环健康：考虑下一轮进化——技能炼化（skill_signals/skill_extract 找候选）、新猜想（selftest_add）、或评测轮（evolve）'])
  // 背离档：文件在动 ⇒ 建议里必须**显式点出**代理量背离（否则文案又把「改技能」当成解药）
  const drifted = run(27, 0, 0)
  assert.match(drifted[0], /代理量背离/)
  assert.match(drifted[0], /Proxy Drift/)
  // ★ 旧文案（「把近期经验炼化成技能/规则」）已删——它正是 Goodhart 的帮凶：照做即让旧环变绿而闭环没动
  assert.equal(drifted.some((l) => /炼化成技能\/规则/.test(l)), false)
})

test('退化：buildSuggestions 脏输入（缺器官快照 / idleDays 脏类型 / cp 无 latest）→ 不抛', () => {
  assert.doesNotThrow(() => buildSuggestions({ lastConfirmedDays: null }))
  assert.doesNotThrow(() => buildSuggestions({ selftest: { ok: true }, evolve: { ok: true, idleDays: 'x' }, checkpoints: { ok: true, latestAgeDays: null }, lastConfirmedDays: 99 }))
  const out = buildSuggestions({ selftest: { ok: false }, evolve: { ok: false }, checkpoints: { ok: false }, lastConfirmedDays: 99 })
  // 读不到的器官不造字段级建议（保守），但布线信号来自入参本身 → 仍然给建议
  assert.equal(out.length, 2)
  assert.ok(out[0].startsWith('⚠ 器官数据源不可读：selftest/evolve/checkpoints'))
  assert.ok(out[1].includes('自指闭环 99 天未合上'))
})

// ---------- 履历统计 ----------

const ev = (id, ts, type) => ({ id, ts, type })

test('computeHistoryStats：主路径——总数/活跃天/连续天数/类型分布/最近事件', () => {
  const events = [
    ev('1', '2026-09-14T10:00:00.000Z', 'cycle'),
    ev('2', '2026-09-13T10:00:00.000Z', 'verdict'),
    ev('3', '2026-09-12T10:00:00.000Z', 'cycle'),
  ]
  const s = computeHistoryStats(events, new Date(2026, 8, 14, 12, 0, 0))
  assert.equal(s.total, 3)
  assert.equal(s.activeDays, 3)
  assert.equal(s.streakDays, 3)
  assert.deepEqual(s.byType, { cycle: 2, verdict: 1 })
  assert.deepEqual(s.recent.map((e) => e.id), ['1', '2', '3'])
  assert.equal(s.firstTs, '2026-09-12T10:00:00.000Z')
  assert.equal(s.lastTs, '2026-09-14T10:00:00.000Z')
})

test('computeHistoryStats：断档日 → 连续天数从最近一天往回数即止', () => {
  const s = computeHistoryStats([ev('1', '2026-09-14T10:00:00.000Z', 'cycle'), ev('2', '2026-09-12T10:00:00.000Z', 'cycle')], new Date(2026, 8, 14, 12, 0, 0))
  assert.equal(s.streakDays, 1)
  assert.equal(s.activeDays, 2)
})

test('computeHistoryStats：recentLimit 生效（默认 10，自定义 2）', () => {
  const events = Array.from({ length: 15 }, (_, i) => ev(String(i), `2026-09-${String(14 - (i % 3)).padStart(2, '0')}T10:00:00.000Z`, 'cycle'))
  assert.equal(computeHistoryStats(events, new Date(2026, 8, 14)).recent.length, 10)
  assert.equal(computeHistoryStats(events, new Date(2026, 8, 14), 2).recent.length, 2)
})

test('退化：空履历 → 全零且 firstTs/lastTs 为 null（不抛）', () => {
  const s = computeHistoryStats([], new Date(2026, 8, 14))
  assert.deepEqual({ total: s.total, activeDays: s.activeDays, streakDays: s.streakDays, firstTs: s.firstTs, lastTs: s.lastTs },
    { total: 0, activeDays: 0, streakDays: 0, firstTs: null, lastTs: null })
  assert.deepEqual(s.recent, [])
})

test('退化：脏事件（ts 非法、type 缺失、null 项）→ 不抛，非法 ts 不计天之列', () => {
  const events = [ev('bad', 'not-a-date', 'cycle'), { id: 'x', ts: '2026-09-14T10:00:00.000Z' }, ev('2', '2026-09-14T11:00:00.000Z', 'note')]
  let s
  assert.doesNotThrow(() => { s = computeHistoryStats(events, new Date(2026, 8, 14)) })
  assert.equal(s.total, 3)
  assert.equal(s.streakDays, 1)
  assert.equal(s.byType['undefined'], 1) // type 缺失 → 键为 'undefined'（沿用原行为，不静默丢弃）
  assert.equal(s.byType.cycle, 1)
})

// ---------- 履历总结 ----------

test('buildSummary：空履历 → 首条引导语', () => {
  assert.equal(buildSummary({ total: 0, streakDays: 0, byType: {} }),
    '还没有进化足迹——从 evolution_log 记录第一次裁决/炼化开始。')
})

test('buildSummary：主路径——累计/连续/最多三类（真实标签映射）', () => {
  const s = buildSummary({ total: 3, streakDays: 3, byType: { cycle: 2, verdict: 1 } })
  assert.equal(s, '累计 3 次进化动作 · 连续 3 天活跃 · 最多: 感知圈 2 / 裁决 1。')
})

test('buildSummary：同标签合并（forge/wire 走各自中文标签）', () => {
  assert.equal(buildSummary({ total: 2, streakDays: 1, byType: { forge: 1, wire: 1 } }),
    '累计 2 次进化动作 · 连续 1 天活跃 · 最多: 炼化 1 / 布线 1。')
})

test('退化：buildSummary 未知类型 / 脏计数 → 不抛（未知类型原样显示）', () => {
  assert.equal(buildSummary({ total: 1, streakDays: 0, byType: { zzz: 1 } }),
    '累计 1 次进化动作 · 连续 0 天活跃 · 最多: zzz 1。')
  // byType 恒由 computeHistoryStats 提供，这里只锁「脏计数不抛」
  assert.doesNotThrow(() => buildSummary({ total: 1, streakDays: 1, byType: { note: undefined } }))
})
