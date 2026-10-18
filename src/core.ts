/**
 * dsh-evolution-core — 纯逻辑层（零 IO，可离线单测）
 *
 * 五环诊断模型 / 建议生成 / 履历统计 / 器官快照抽取。
 * 设计文档：docs/evolution-core-design.md §4.2 / §5
 *
 * 数据字段以 2026-09-03 实测各器官 JSON 为准（见 docs 3.1 + 实现备注）。
 */

// ---------- 类型 ----------

/** 器官快照（readXxx 的返回值；ok=false = 数据源不可读） */
export interface OrganSnapshot {
  ok: boolean
  [k: string]: unknown
}

export interface RingState {
  name: string
  /** 环名中文 */
  label: string
  state: 'green' | 'yellow' | 'red' | 'unknown'
  detail: string
}

export interface BrokenRing {
  ring: string
  state: string
  signal: string
  suggestion: string
}

export interface HistoryEvent {
  id: string
  ts: string
  type: string
  detail?: string
  ref?: string | null
}

// ---------- 工具函数 ----------

/** 本地日期 YYYY-MM-DD（中国时区 UTC+8 语义，用本地时间） */
export function localDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysBetween(iso: string | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000))
}

/** 安全数字：null/undefined/NaN → 0 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ---------- 器官快照抽取（入参 = 已 parse 的 JSON；容错） ----------

/** self-test.json → {total,active,finding,confirmed,refuted,activeWithEvidence,latestUpdatedAt,latestConfirmedAt} */
export function summarizeSelftest(raw: unknown): OrganSnapshot {
  const r = raw as { hypotheses?: unknown[] } | null
  const hs = Array.isArray(r?.hypotheses) ? (r!.hypotheses as any[]) : []
  const status = (h: any) => (h?.status as string) ?? 'unknown'
  const active = hs.filter((h) => status(h) === 'active').length
  const finding = hs.filter((h) => status(h) === 'finding').length
  const confirmed = hs.filter((h) => status(h) === 'confirmed').length
  const refuted = hs.filter((h) => status(h) === 'refuted').length
  const activeHs = hs.filter((h) => status(h) === 'active')
  const activeWithEvidence = activeHs.some((h) => Array.isArray(h?.evidence) && h.evidence.length > 0)
  let latestUpdatedAt: string | null = null
  for (const h of hs) {
    if (typeof h?.updatedAt === 'string' && (latestUpdatedAt === null || h.updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = h.updatedAt
    }
  }
  // 自指闭环**真源**：最新一条**普通** confirmed 的 updatedAt（= 裁决→布线最后合上时刻）。
  // ⚠ 必须排除 enabling：使能型声明兑现后也是 confirmed，但那是「依赖路径兑现」不是「布线」——
  //   计入会让读数比实际新（**假活**），而这一面存在的理由正是抓假活。
  //   同源纪律见 dsh-agent-self-rewrite/src/status.ts:186（两插件读同一个 self-test.json ⇒ 判据必须一致）。
  let latestConfirmedAt: string | null = null
  for (const h of hs) {
    if (status(h) !== 'confirmed') continue
    if ((h as { enabling?: unknown })?.enabling !== undefined) continue
    const u = (h as { updatedAt?: unknown })?.updatedAt
    if (typeof u !== 'string' || u.length === 0) continue
    const t = Date.parse(u)
    if (Number.isNaN(t)) continue
    if (latestConfirmedAt === null || t > Date.parse(latestConfirmedAt)) latestConfirmedAt = u
  }
  return { ok: true, total: hs.length, active, finding, confirmed, refuted, activeWithEvidence, latestUpdatedAt, latestConfirmedAt }
}

/** emotion-state.json → {today,statsKeys,triggerCount,weights,emotions} */
export function summarizeEmotion(raw: unknown): OrganSnapshot {
  const r = raw as {
    today?: string
    stats?: Record<string, unknown>
    triggerCount?: number
    weights?: Record<string, number>
    emotions?: Record<string, number>
  } | null
  const stats = r?.stats ?? {}
  return {
    ok: true,
    today: r?.today ?? null,
    statsKeys: Object.keys(stats),
    stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, typeof v === 'number' ? v : String(v)])),
    triggerCount: num(r?.triggerCount),
    weights: r?.weights ?? {},
    emotions: r?.emotions ?? {},
  }
}

/** reflection-state.json → {lastTriggerDate,triggerCount,lastTriggerAt} */
export function summarizeReflection(raw: unknown): OrganSnapshot {
  const r = raw as { lastTriggerDate?: string; triggerCount?: number; lastTriggerAt?: string } | null
  return {
    ok: true,
    lastTriggerDate: r?.lastTriggerDate ?? null,
    triggerCount: num(r?.triggerCount),
    lastTriggerAt: r?.lastTriggerAt ?? null,
  }
}

/** life-core/state.json → {status,todayTurns,cycleMinutes,bornAt,selfRole} */
export function summarizeLifeCore(raw: unknown): OrganSnapshot {
  const r = raw as {
    status?: string
    todayTurns?: number
    cycleMinutes?: number
    bornAt?: string
    self?: { role?: string }
  } | null
  return {
    ok: true,
    status: r?.status ?? null,
    todayTurns: num(r?.todayTurns),
    cycleMinutes: num(r?.cycleMinutes),
    bornAt: r?.bornAt ?? null,
    selfRole: r?.self?.role ?? null,
  }
}

/** .evolve/ledger.json → {initialized,generationCount,lastGenAt,idleDays,activeVersion}（需 now 算 idle） */
export function summarizeEvolve(raw: unknown, now: Date): OrganSnapshot {
  const r = raw as {
    initialized?: boolean
    generations?: Array<{ at?: string }>
    active?: Record<string, string>
  } | null
  const gens = Array.isArray(r?.generations) ? r!.generations : []
  let lastGenAt: string | null = null
  for (const g of gens) {
    if (typeof g?.at === 'string' && (lastGenAt === null || g.at > lastGenAt)) lastGenAt = g.at
  }
  const idleDays = daysBetween(lastGenAt ?? undefined, now)
  return {
    ok: true,
    initialized: r?.initialized ?? false,
    generationCount: gens.length,
    lastGenAt,
    idleDays: idleDays === null ? null : Math.max(0, idleDays),
    activeVersion: r?.active ?? {},
  }
}

/** storages/agent_memory.json → 只读顶层键（不展开条目） */
export function summarizeMemory(raw: unknown): OrganSnapshot {
  const r = raw as { unit?: unknown; global?: unknown; tables?: { entries?: unknown } } | null
  const unit = r?.unit
  const global = r?.global
  const tables = r?.tables
  const entries = (tables as any)?.entries
  const entryCount =
    entries != null && typeof entries === 'object'
      ? Object.keys(entries as Record<string, unknown>).length
      : Array.isArray(entries)
        ? entries.length
        : 0
  return {
    ok: true,
    unitKeys: unit != null && typeof unit === 'object' ? Object.keys(unit as object) : [],
    globalKeys: global != null && typeof global === 'object' ? Object.keys(global as object) : [],
    tablesKeys: tables != null && typeof tables === 'object' ? Object.keys(tables as object) : [],
    entryCount,
  }
}

/** checkpoints/ 目录列表 → {count,latest,latestAgeDays} */
export function summarizeCheckpoints(dirNames: string[], now: Date): OrganSnapshot {
  const names = [...dirNames].sort() // 目录名 YYYYMMDD-HHMMSS-hex，字典序=时间序
  const latest = names.length > 0 ? names[names.length - 1]! : null
  let latestAgeDays: number | null = null
  if (latest !== null) {
    // 目录名形如 20260903-093458-295a1f → 解析首段
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(latest)
    if (m !== null) {
      const t = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6]),
      ).getTime()
      if (!Number.isNaN(t)) latestAgeDays = Math.max(0, Math.floor((now.getTime() - t) / 86400000))
    }
  }
  return { ok: true, count: names.length, latest, latestAgeDays }
}

// ---------- 五环诊断 ----------

const RINGS = [
  { key: 'hypothesize', label: '猜想' },
  { key: 'evidence', label: '采证' },
  { key: 'finding', label: 'finding' },
  { key: 'verdict', label: '裁决' },
  { key: 'wire', label: '布线' },
] as const

export type RingKey = (typeof RINGS)[number]['key']

export interface RingInput {
  selftest?: OrganSnapshot
  /**
   * **真源**：最新一条普通 confirmed 假设距今天数（自指引擎「裁决→布线」闭环最后合上）；`null` = 从未布线。
   *
   * 2026-10-18 换源（原为「技能目录 mtime」）。事故形状 = **Proxy Drift**（arXiv:2610.21646 §7）：
   * 代理量（文件 mtime）**升**而真量（自指闭环）**停 27 天**，而门看不出——**无对手、无自指**，
   * 纯粹因为「任何技能文件写入都让 mtime 变新」（同步镜像 / 改错别字 / 编辑技能全都算）。
   * 论文原话：*"The gate cannot see the loss, because the loss lives beyond its time budget."*
   */
  lastConfirmedDays: number | null
  /**
   * **代理量**：技能目录最新 mtime 距今天数（「文件在动」≠「布线在推进」）。
   * 只用于**背离检测**，不参与环状态判定——它正是那个会骗人的量。
   */
  fileActivityDays?: number | null
  /** 布线环 green 阈值（天，默认 7）。2026-10-18 从 Config 接通（原「半死参数」，语义文档 U3）。 */
  wireFreshDays?: number
}

/** 布线环阈值（天）：`fresh` green 线 · `staleAfter` 明显偏久 · `hardStale` 硬停摆 */
export function wireThresholds(wireFreshDays?: number): { fresh: number; staleAfter: number; hardStale: number } {
  const fresh = typeof wireFreshDays === 'number' && Number.isFinite(wireFreshDays) && wireFreshDays > 0 ? wireFreshDays : 7
  const staleAfter = Math.max(fresh * 2, 14)
  const hardStale = Math.max(staleAfter * 2, 30)
  return { fresh, staleAfter, hardStale }
}

/** 五环判定（设计文档 §4.2 判定表） */
export function diagnoseRings(input: RingInput): { rings: RingState[]; broken: BrokenRing[] } {
  const st = input.selftest
  const stOk = st?.ok === true
  const active = stOk ? num(st?.active) : 0
  const finding = stOk ? num(st?.finding) : 0
  const verdictTotal = stOk ? num(st?.confirmed) + num(st?.refuted) : 0

  const rings: RingState[] = []
  const broken: BrokenRing[] = []

  // ① 猜想：active ≥2 green / 1 yellow / 0 但库里有终态＝**空窗（yellow）** / 库全空 red
  if (!stOk) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'yellow', detail: '数据源不可读' })
  } else if (active >= 2) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'green', detail: `${active} 条检验中猜想` })
  } else if (active === 1) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'yellow', detail: '仅 1 条检验中猜想' })
  } else if (verdictTotal > 0) {
    // 2026-09-21 加：区分「空窗」与「断点」。库里有终态假设（confirm/refute 都算）说明引擎在跑、
    // 纪律已收敛；此时 active=0 是**收敛态**而非缺猜想。不区分就会每圈催"补一条"——那是拿指标当目标
    // （Goodhart）。空窗只提示、不列为 broken。
    rings.push({ name: 'hypothesize', label: '猜想', state: 'yellow',
      detail: `空窗（${verdictTotal} 条已终态：${num(st?.confirmed)} 确认 / ${num(st?.refuted)} 淘汰）——收敛态，非断点` })
  } else {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'red', detail: '库为空：既无检验中猜想，也无终态记录' })
    broken.push({ ring: 'hypothesize', state: 'red', signal: 'selftest 库为空（active=0 且 终态=0）', suggestion: 'selftest_add 一条可证伪自我假设' })
  }

  // ② 采证：active 有证据 green / active 但全 0 yellow / 空窗 yellow / 库空 red
  if (!stOk) {
    rings.push({ name: 'evidence', label: '采证', state: 'yellow', detail: '数据源不可读' })
  } else if (active > 0 && st?.activeWithEvidence === true) {
    rings.push({ name: 'evidence', label: '采证', state: 'green', detail: `${active} 条 active 假设证据在累积` })
  } else if (active > 0) {
    rings.push({ name: 'evidence', label: '采证', state: 'yellow', detail: 'active 假设证据均为 0（探针未命中或未配置）' })
  } else if (verdictTotal > 0) {
    rings.push({ name: 'evidence', label: '采证', state: 'yellow', detail: '无 active 假设可采证（空窗：既有猜想都已完成采证）' })
  } else {
    rings.push({ name: 'evidence', label: '采证', state: 'red', detail: '无 active 假设可采证' })
    broken.push({ ring: 'evidence', state: 'red', signal: '无 active 假设', suggestion: '先 selftest_add 建立检验中猜想' })
  }

  // ③ finding：0 green / ≥1 red（积压）
  if (!stOk) {
    rings.push({ name: 'finding', label: 'finding', state: 'yellow', detail: '数据源不可读' })
  } else if (finding === 0) {
    rings.push({ name: 'finding', label: 'finding', state: 'green', detail: '无 finding 积压' })
  } else {
    rings.push({ name: 'finding', label: 'finding', state: 'red', detail: `${finding} 条 finding 待裁决` })
    broken.push({ ring: 'finding', state: 'red', signal: `finding 积压 = ${finding}`, suggestion: `selftest_review 裁决（confirm 布线 / refute 淘汰 / refine 细化）` })
  }

  // ④ 裁决：≥5 green / 1-4 yellow / 0 red
  if (!stOk) {
    rings.push({ name: 'verdict', label: '裁决', state: 'yellow', detail: '数据源不可读' })
  } else if (verdictTotal >= 5) {
    rings.push({ name: 'verdict', label: '裁决', state: 'green', detail: `${verdictTotal} 次历史裁决（confirmed+refuted）` })
  } else if (verdictTotal >= 1) {
    rings.push({ name: 'verdict', label: '裁决', state: 'yellow', detail: `仅 ${verdictTotal} 次历史裁决` })
  } else {
    rings.push({ name: 'verdict', label: '裁决', state: 'red', detail: '从未裁决（0）' })
    broken.push({ ring: 'verdict', state: 'red', signal: 'confirmed+refuted = 0', suggestion: '先让假设跑出 finding，再走第一次裁决' })
  }

  // ⑤ 布线：**真源 = 自指闭环**（最新普通 confirmed），代理量（文件 mtime）只做背离检测。
  //    见 RingInput.lastConfirmedDays 头注（Proxy Drift 事故 + 论文依据）。
  const { fresh, staleAfter, hardStale } = wireThresholds(input.wireFreshDays)
  const wireDays = input.lastConfirmedDays ?? null
  const fileDays = input.fileActivityDays ?? null
  // 背离：文件在动（≤fresh）而闭环停在 staleAfter 之外 ⇒ **代理量正在掩盖真量**
  const drift = wireDays !== null && wireDays > staleAfter && fileDays !== null && fileDays <= fresh
  if (wireDays === null) {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: '自指引擎从未裁决布线（无普通 confirmed 假设）' })
    broken.push({ ring: 'wire', state: 'red', signal: '无布线记录（普通 confirmed = 0）', suggestion: '让一条猜想跑出 finding 后走 rewrite_verdict(confirm)——⚠ 使能型声明（enabling）兑现不算布线' })
  } else if (wireDays <= fresh) {
    rings.push({ name: 'wire', label: '布线', state: 'green', detail: `自指闭环 ${wireDays} 天前合上` })
  } else if (wireDays <= staleAfter) {
    rings.push({ name: 'wire', label: '布线', state: 'yellow', detail: `自指闭环 ${wireDays} 天前合上（偏久）` })
  } else if (drift) {
    rings.push({ name: 'wire', label: '布线', state: 'red',
      detail: `自指闭环停 ${wireDays} 天，而技能文件 ${fileDays} 天前还在动——**代理量背离**（文件活动 ≠ 布线推进）` })
    broken.push({ ring: 'wire', state: 'red',
      signal: `代理量背离：fileActivity=${fileDays}d（≤${fresh} 新鲜）而 lastConfirmed=${wireDays}d（>${staleAfter}）`,
      suggestion: '这正是 Proxy Drift 的形状——文件在动让人以为在布线。查 rewrite_status 停滞读数（在采证 0 条 ⇒ 采证链断）后推进，或**明确记录本季收敛**（无意识停摆 ≠ 有意识收敛）' })
  } else if (wireDays > hardStale) {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: `${wireDays} 天无裁决布线（自指闭环停摆）` })
    broken.push({ ring: 'wire', state: 'red', signal: `lastConfirmed ${wireDays} 天（>${hardStale}）`, suggestion: '查 rewrite_status 停滞读数并推进：开一条新猜想 / 给在采证假设补证据 / 明确记录收敛' })
  } else {
    rings.push({ name: 'wire', label: '布线', state: 'yellow', detail: `自指闭环 ${wireDays} 天前合上（偏久，文件活动未掩盖：${fileDays ?? '?'} 天前）` })
  }

  return { rings, broken }
}

// ---------- 建议生成（§5.1 优先级） ----------

export interface SuggestionInput {
  selftest?: OrganSnapshot
  evolve?: OrganSnapshot
  checkpoints?: OrganSnapshot
  /** 真源：自指闭环最后合上距今天数（见 RingInput.lastConfirmedDays） */
  lastConfirmedDays: number | null
  /** 代理量：技能目录最新 mtime 距今天数（只做背离提示） */
  fileActivityDays?: number | null
  wireFreshDays?: number
}

/** 生成行动建议（优先级排序，来自设计 §5.1 规则 1-7） */
export function buildSuggestions(input: SuggestionInput): string[] {
  const out: string[] = []
  const st = input.selftest
  const ev = input.evolve
  const cp = input.checkpoints

  // 器官数据源不可读（最高优先——路径/格式问题要先修）
  const unreadable: string[] = []
  if (st?.ok !== true) unreadable.push('selftest')
  if (ev?.ok !== true) unreadable.push('evolve')
  if (cp?.ok !== true) unreadable.push('checkpoints')
  if (unreadable.length > 0) {
    out.push(`⚠ 器官数据源不可读：${unreadable.join('/')}——检查文件路径与格式（只读读取器容错返回，需人工核对）`)
  }

  const finding = st?.ok === true ? num(st?.finding) : 0
  if (finding > 0) {
    out.push(`【裁决】有 ${finding} 条 finding 待裁决：selftest_review（confirm 布线 / refute 淘汰 / refine 细化）`)
  }

  const idleDays = ev?.ok === true ? (ev?.idleDays as number | null | undefined) : null
  // ⚠ 主人 2026-09-20 定调 + 2026-10-15 重申：「别跑进化轮了，**收益不高，测试基准太旧了**」
  //   ⇒ **完整评测轮（spawn + submit）已暂停**；但 §5.16 要的**最小探测**（判仪器死活）不受影响。
  //   ⇒ 建议文案必须**把这两件事分开** —— 否则建议会把人推去跑整轮
  //     （2026-10-15 实测：我探测完**顺手把整轮也跑了**，正是这个形状）。
  if (idleDays !== null && idleDays !== undefined && idleDays > 14) {
    out.push(`【评测】evolve 已闲置 ${idleDays} 天（>14 红）：⚠ **完整评测轮已由主人暂停**（09-20 定调 / 10-15 重申：收益不高、基准太旧）⇒ **不要 spawn/submit**；只做**最小探测**（一次 start 即可定性仪器死活）；真要跑整轮**先问主人**`)
  } else if (idleDays !== null && idleDays !== undefined && idleDays > 7) {
    out.push(`【评测】evolve 闲置 ${idleDays} 天（>7 黄）：完整评测轮**已暂停**（主人 09-20/10-15）⇒ **不 spawn/submit**；可做**最小探测**（一次 start）`)
  }

  const active = st?.ok === true ? num(st?.active) : 0
  const terminal = st?.ok === true ? num(st?.confirmed) + num(st?.refuted) : 0
  if (active === 0 && st?.ok === true && terminal > 0) {
    out.push(`【猜想】空窗（${terminal} 条已终态：猜想环空着＝收敛，不是缺猜想）。**不要为点亮该环而新增假设**——满足门槛才开（① 该量没有任何已终态仪器能测 ② 是我现在真的不确定的纪律），否则转机制承载（把序/计数做进工具链）`)
  } else if (active === 0 && st?.ok === true) {
    out.push('【猜想】无检验中猜想：selftest_add 一条可证伪自我假设（statement + prediction + probe）')
  } else if (active > 0 && st?.activeWithEvidence !== true && st?.ok === true) {
    out.push('【采证】有 active 假设但证据 0：检查探针配置是否合理（tool 名/阈值/窗口），或确认行为确实未触发')
  }

  // 布线建议（2026-10-18 换源）：**旧文案是 Goodhart 的帮凶**——它说「把经验炼化成技能/规则」，
  // 而环的旧判据是技能目录 mtime ⇒ 照做即可让环变绿，**而自指闭环一步没动**。
  // 新文案只指向真源（闭环），且显式点出代理量背离。
  const wireDays = input.lastConfirmedDays ?? null
  const { fresh: wireFresh } = wireThresholds(input.wireFreshDays)
  const fileDays = input.fileActivityDays ?? null
  if (wireDays === null) {
    out.push('【布线】自指引擎从未裁决布线（普通 confirmed = 0）：让一条猜想跑出 finding 后走 rewrite_verdict(confirm)')
  } else if (wireDays > wireFresh) {
    const drift = wireDays > wireFresh * 2 && fileDays !== null && fileDays <= wireFresh
    out.push(`【布线】自指闭环 ${wireDays} 天未合上（阈值 ${wireFresh} 天）` +
      (drift ? `；⚠ 而技能文件 ${fileDays} 天前还在动——**代理量背离**（Proxy Drift：文件活动 ≠ 布线推进）` : '') +
      '：查 rewrite_status 停滞读数（在采证 0 条 ⇒ 采证链断）后推进，或**明确记录本季收敛**（无意识停摆 ≠ 有意识收敛）')
  }

  const cpAge = cp?.ok === true ? (cp?.latestAgeDays as number | null | undefined) : null
  if (cpAge !== null && cpAge !== undefined && cpAge > 3) {
    out.push(`【存档】${cpAge} 天未存档（最近 ${cp?.latest ?? '?'}）：checkpoint_create 存档点（保活+试错回滚）`)
  }

  if (out.length === 0) {
    out.push('五环健康：考虑下一轮进化——技能炼化（skill_signals/skill_extract 找候选）、新猜想（selftest_add）、或评测轮（evolve）')
  }
  return out
}

// ---------- 履历统计（§5.4） ----------

export interface HistoryStats {
  total: number
  activeDays: number
  streakDays: number
  byType: Record<string, number>
  recent: HistoryEvent[]
  firstTs: string | null
  lastTs: string | null
}

/** 计算履历统计。streakDays：从最近事件日往回数连续有事件的天数 */
export function computeHistoryStats(events: HistoryEvent[], now: Date, recentLimit = 10): HistoryStats {
  const total = events.length
  const byType: Record<string, number> = {}
  const daySet = new Set<string>()
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
    const t = new Date(e.ts)
    if (!Number.isNaN(t.getTime())) daySet.add(localDay(t))
  }
  const days = [...daySet].sort() // YYYY-MM-DD 字典序 = 时间序
  // streak：从最新一天往回数连续（相邻日）
  let streakDays = 0
  if (days.length > 0) {
    const last = new Date(days[days.length - 1]! + 'T00:00:00')
    // 若最近事件日早于今天，从该日算起即可（按设计 v1：从最近事件日往回数）
    let cursor = new Date(last)
    streakDays = 0
    while (true) {
      const key = localDay(cursor)
      if (!daySet.has(key)) break
      streakDays += 1
      cursor = new Date(cursor.getTime() - 86400000)
    }
  }
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return {
    total,
    activeDays: days.length,
    streakDays,
    byType,
    recent: sorted.slice(0, recentLimit),
    firstTs: sorted.length > 0 ? sorted[sorted.length - 1]!.ts : null,
    lastTs: sorted.length > 0 ? sorted[0]!.ts : null,
  }
}

/** 鼓舞总结（§5.4 summary 模板） */
export function buildSummary(stats: HistoryStats): string {
  if (stats.total === 0) {
    return '还没有进化足迹——从 evolution_log 记录第一次裁决/炼化开始。'
  }
  const parts: string[] = []
  const typeLabel: Record<string, string> = {
    verdict: '裁决', forge: '炼化', evolve: '评测', wire: '布线',
    reflect: '反思', checkpoint: '存档', cycle: '感知圈', note: '备注',
  }
  const countByLabel: Record<string, number> = {}
  for (const [t, c] of Object.entries(stats.byType)) {
    const label = typeLabel[t] ?? t
    countByLabel[label] = (countByLabel[label] ?? 0) + c
  }
  const top = Object.entries(countByLabel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, c]) => `${label} ${c}`)
    .join(' / ')
  parts.push(`累计 ${stats.total} 次进化动作`)
  parts.push(`连续 ${stats.streakDays} 天活跃`)
  if (top.length > 0) parts.push(`最多: ${top}`)
  return parts.join(' · ') + '。'
}
