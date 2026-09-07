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

/** self-test.json → {total,active,finding,confirmed,refuted,activeWithEvidence,latestUpdatedAt} */
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
  return { ok: true, total: hs.length, active, finding, confirmed, refuted, activeWithEvidence, latestUpdatedAt }
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
  /** 布线代理：最近布线动作距今天数（AGENTS.md/skills 最新 mtime），null=无记录 */
  lastWireDays: number | null
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

  // ① 猜想：active ≥2 green / 1 yellow / 0 red
  if (!stOk) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'yellow', detail: '数据源不可读' })
  } else if (active >= 2) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'green', detail: `${active} 条检验中猜想` })
  } else if (active === 1) {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'yellow', detail: '仅 1 条检验中猜想' })
  } else {
    rings.push({ name: 'hypothesize', label: '猜想', state: 'red', detail: '无检验中猜想（0 active）' })
    broken.push({ ring: 'hypothesize', state: 'red', signal: 'selftest active 假设 = 0', suggestion: 'selftest_add 一条可证伪自我假设' })
  }

  // ② 采证：active 有证据 green / active 但全 0 yellow / 无 active red（假设环红则随红，避免双报）
  if (!stOk) {
    rings.push({ name: 'evidence', label: '采证', state: 'yellow', detail: '数据源不可读' })
  } else if (active > 0 && st?.activeWithEvidence === true) {
    rings.push({ name: 'evidence', label: '采证', state: 'green', detail: `${active} 条 active 假设证据在累积` })
  } else if (active > 0) {
    rings.push({ name: 'evidence', label: '采证', state: 'yellow', detail: 'active 假设证据均为 0（探针未命中或未配置）' })
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

  // ⑤ 布线：lastWireDays ≤7 green / ≤30 yellow / null 或 >30 red
  const wireDays = input.lastWireDays ?? null
  if (wireDays === null) {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: '无布线记录（AGENTS.md/skills 未见近期更新）' })
    broken.push({ ring: 'wire', state: 'red', signal: '无布线记录', suggestion: '把近期经验炼化成技能/规则（skill_commit / 编辑 AGENTS.md）并 evolution_log(type=wire)' })
  } else if (wireDays <= 7) {
    rings.push({ name: 'wire', label: '布线', state: 'green', detail: `最近布线 ${wireDays} 天前` })
  } else if (wireDays <= 30) {
    rings.push({ name: 'wire', label: '布线', state: 'yellow', detail: `最近布线 ${wireDays} 天前（偏久）` })
  } else {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: `${wireDays} 天无布线动作` })
    broken.push({ ring: 'wire', state: 'red', signal: `${wireDays} 天无布线`, suggestion: '把近期经验炼化成技能/规则并 evolution_log(type=wire)' })
  }

  return { rings, broken }
}

// ---------- 建议生成（§5.1 优先级） ----------

export interface SuggestionInput {
  selftest?: OrganSnapshot
  evolve?: OrganSnapshot
  checkpoints?: OrganSnapshot
  lastWireDays: number | null
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
  if (idleDays !== null && idleDays !== undefined && idleDays > 14) {
    out.push(`【评测】evolve 已闲置 ${idleDays} 天（>14 红）：考虑发起评测轮（evolve_round_start + evolve_spawn + evolve_submit）`)
  } else if (idleDays !== null && idleDays !== undefined && idleDays > 7) {
    out.push(`【评测】evolve 闲置 ${idleDays} 天（>7 黄）：可考虑发起一轮评测`)
  }

  const active = st?.ok === true ? num(st?.active) : 0
  if (active === 0 && st?.ok === true) {
    out.push('【猜想】无检验中猜想：selftest_add 一条可证伪自我假设（statement + prediction + probe）')
  } else if (active > 0 && st?.activeWithEvidence !== true && st?.ok === true) {
    out.push('【采证】有 active 假设但证据 0：检查探针配置是否合理（tool 名/阈值/窗口），或确认行为确实未触发')
  }

  const wireDays = input.lastWireDays ?? null
  if (wireDays !== null && wireDays > 7) {
    out.push(`【布线】${wireDays} 天无布线动作：把近期经验炼化成技能/规则（skill_commit 或编辑 AGENTS.md），完成后 evolution_log(type=wire)`)
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
