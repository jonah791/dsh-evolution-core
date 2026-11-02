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
  /**
   * 证据指针（2026-11-02 新增）：这次推进**凭什么说它改变了东西**。
   *
   * 形状 = `path:line` / 记忆 id / 技能名 / 提交号 / 工具名。空 ⇒ 这次推进**未入账为有证据**。
   * 存在理由：AGENTS.md §3.4「采纳 ≠ 有效」——20 次动作全绿但一条证据都没有，
   * 那是「它还留着」，不是「它有效」。本字段让「有没有效」变成可数的事实。
   */
  evidence?: string
  /**
   * 改前/改后的读数差（可选，自由文本）：如 `dst 27→11 页`、`命中率 0.42→0.61`。
   *
   * 与 `evidence` 的分工：evidence 指「去哪看」，delta 指「变了多少」。
   * 只有 evidence 没有 delta 也是合法的（有些改动只能证明存在，不能证明幅度）。
   */
  delta?: string
  /**
   * 可复用组件清单（2026-11-03 新增，`type=verdict` 时**必填**）。
   *
   * 存在理由（t-d9d60529）：我的裁决是**整体裁决**——一个「整体不适配」的产物里，
   * 有用的组件会随它一起被归档。实例：DKGI 两场景均不适配 ⇒ 整条归档，但它产出了一条
   * 新判据「痛点存在 ≠ 痛点有代价」，那正是被整体分掩盖的组件。
   * 形状 = 每项「类型:一句话」（类型 ∈ 判据/工具/教训/方法/判据修正…）；没有可复用组件
   * 写 `["none"]`——**显式写 none 与忘了写，在数据上必须可区分**。
   * 旧记录没有本字段是合法的（读侧按缺失处理，不做迁移）。
   */
  salvage?: readonly string[]
}

// ---------- 工具函数 ----------

/**
 * 归一化可复用组件清单：转字符串、去空白、丢空项。非数组一律视为空。
 * @param salvage - 原始输入（可能来自工具参数，可能是 undefined）。
 * @returns 清理后的组件列表；空列表 = 没给。
 */
export function normalizeSalvage(salvage: unknown): string[] {
  return (Array.isArray(salvage) ? salvage : [])
    .map((s) => String(s).trim())
    .filter((s) => s !== '')
}

/**
 * 裁决的「可复用组件」准入（fail-closed，判断型字段禁默认值）。
 *
 * `type="verdict"` 时必须显式回答「这次裁决里有什么可以带走」：给出清单，或写 `["none"]`。
 * 不设默认值——默认值会让「没想过」与「想过、没有」在数据上同形，而 t-d9d60529 的缺口
 * （整体裁决把有用组件一起埋掉）正是这样形成的。
 * @param type - 动作类型。
 * @param salvage - 原始输入。
 * @returns 错误文案；通过返回 null。
 */
export function validateSalvage(type: string, salvage: unknown): string | null {
  if (type !== 'verdict') return null
  if (normalizeSalvage(salvage).length > 0) return null
  return 'type="verdict" 必须带 salvage：列出这次裁决里可复用的组件（每项「类型:一句话」，类型 ∈ 判据/工具/教训/方法），'
    + '确实没有可带走的就写 ["none"]。理由：整体裁决会把「整体不适配、但产出有用组件」的东西连组件一起埋掉（t-d9d60529）。'
}

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
  /**
   * **有意识收敛声明**是否有效（2026-10-31 新增，t-8df40786）。
   *
   * 病：布线环真源只认「普通 confirmed」，于是要么为点亮环开一条不该开的假设（Goodhart），
   * 要么长期红灯 ⇒ 告警疲劳。同型先例 = 2026-09-21 猜想环（`active=0 且库中有终态` 判 yellow 空窗）。
   *
   * 修法：存在**我显式写下的收敛声明** ∧ 无 active 猜想 ∧ 无 finding 积压 ⇒ yellow「本季收敛（已声明）」，
   * **不进 broken**。声明由 `index.ts` 从磁盘读并判有效期，本函数只收布尔值以保持纯函数。
   *
   * ⚠ 三条边界（判据见 tests）：
   * - **未声明**的长期红灯仍判红（无意识停摆 ≠ 有意识收敛）
   * - 有 active 猜想时**不得**走收敛分支（有东西在跑就不算收敛）
   * - 有 finding 积压时**不得**走收敛分支（有活没干完不算收敛）
   */
  convergenceActive?: boolean
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
  // 有意识收敛（2026-10-31 t-8df40786）：声明有效 ∧ 无 active 猜想 ∧ 无 finding 积压。
  // ⚠ 后两条是**反例护栏**——有东西在跑、或有活没干完，都不算「收敛」，不许被声明吞掉。
  const converged = input.convergenceActive === true && active === 0 && finding === 0
  if (wireDays === null) {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: '自指引擎从未裁决布线（无普通 confirmed 假设）' })
    broken.push({ ring: 'wire', state: 'red', signal: '无布线记录（普通 confirmed = 0）', suggestion: '让一条猜想跑出 finding 后走 rewrite_verdict(confirm)——⚠ 使能型声明（enabling）兑现不算布线' })
  } else if (wireDays <= fresh) {
    rings.push({ name: 'wire', label: '布线', state: 'green', detail: `自指闭环 ${wireDays} 天前合上` })
  } else if (wireDays <= staleAfter) {
    rings.push({ name: 'wire', label: '布线', state: 'yellow', detail: `自指闭环 ${wireDays} 天前合上（偏久）` })
  } else if (converged) {
    // 已声明收敛：yellow 而非 red，且**不进 broken**——「无意识停摆」与「有意识收敛」在这里分道。
    rings.push({ name: 'wire', label: '布线', state: 'yellow',
      detail: `本季收敛（已声明）：自指闭环 ${wireDays} 天未合上，但无 active 猜想、无 finding 积压` })
  } else if (drift) {
    rings.push({ name: 'wire', label: '布线', state: 'red',
      detail: `自指闭环停 ${wireDays} 天，而技能文件 ${fileDays} 天前还在动——**代理量背离**（文件活动 ≠ 布线推进）` })
    broken.push({ ring: 'wire', state: 'red',
      signal: `代理量背离：fileActivity=${fileDays}d（≤${fresh} 新鲜）而 lastConfirmed=${wireDays}d（>${staleAfter}）`,
      suggestion: '这正是 Proxy Drift 的形状——文件在动让人以为在布线。二选一：**(a) 推进闭环**（开猜想 → 补证据 → rewrite_verdict confirm）⇒ 本环转绿；**(b) 显式声明本季收敛**（写 .dsh/evolution-convergence.json，见 README）⇒ 本环转 yellow「已声明收敛」，不再列 broken。⚠ 声明是**显式动作**，机制不会自动假设收敛' })
  } else if (wireDays > hardStale) {
    rings.push({ name: 'wire', label: '布线', state: 'red', detail: `${wireDays} 天无裁决布线（自指闭环停摆）` })
    broken.push({ ring: 'wire', state: 'red', signal: `lastConfirmed ${wireDays} 天（>${hardStale}）`, suggestion: '自指闭环硬停摆。查 rewrite_status 后二选一：推进闭环（开猜想 → 补证据 → rewrite_verdict confirm）⇒ 转绿；或显式声明本季收敛（写 .dsh/evolution-convergence.json）⇒ 转 yellow「已声明收敛」' })
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
  /**
   * 有意识收敛声明是否有效（见 RingInput.convergenceActive）。
   *
   * 影响**文案**而非环状态：声明成立时不再催「推进闭环」——催一次是提醒，催四十次是噪音。
   * ⚠ 护栏与 `diagnoseRings` 同源：还需 selftest 的 `active === 0 && finding === 0`。
   */
  convergenceActive?: boolean
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
    // 2026-10-31（t-8df40786）：已声明收敛时不再催推进——催一次是提醒，催四十次是噪音。
    // 但必须**同时**无 active 猜想、无 finding 积压（与 diagnoseRings 的护栏同源），否则声明不成立。
    const convergedHere = input.convergenceActive === true
      && (st?.ok !== true || (num(st?.active) === 0 && num(st?.finding) === 0))
    if (convergedHere) {
      // 2026-11-02 修：原文只写「已声明本季收敛」，**没写收敛的范围** ⇒ 被读成停工令，
      // 布线环因此 42 天没动（感知圈记录原话：「布线已声明本季收敛」⇒ 不碰进化环）。
      // 而声明文件自己写清了：收敛的是 **rewrite 自指闭环（评测轮口径）**，
      // 「改为把经验写进技能与记忆」是**换路，不是停做**。范围必须在读数里说全，
      // 否则读的人（包括我自己）会按最省事的解释去理解。
      out.push(`【布线】自指闭环 ${wireDays} 天未合上，但**已声明本季收敛**（.dsh/evolution-core/evolution-convergence.json）——这是有意识的选择，不是停摆。`
        + `⚠ **收敛范围仅限 rewrite 自指闭环（完整评测轮口径）**：「把经验写进技能与记忆」这条真布线**不在收敛范围内，照常推进并记 evolution_log(type=wire, evidence=…)**。重开条件见声明文件的 reason 字段`)
    } else {
      out.push(`【布线】自指闭环 ${wireDays} 天未合上（阈值 ${wireFresh} 天）` +
        (drift ? `；⚠ 而技能文件 ${fileDays} 天前还在动——**代理量背离**（Proxy Drift：文件活动 ≠ 布线推进）` : '') +
        '。二选一：**(a) 推进闭环**（开猜想 → 补证据 → rewrite_verdict confirm）⇒ 转绿；**(b) 显式声明本季收敛**（写 `.dsh/evolution-core/evolution-convergence.json`，格式见 README）⇒ 本环转 yellow「已声明收敛」且不再列断点。⚠ 声明是**显式动作**，机制不会自动假设收敛')
    }
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

// ---------- 推进读数（2026-11-02：让自进化成为 loop 的一环） ----------

/**
 * 哪些动作算「推进」。
 *
 * 判据：**它有没有改变任何东西**。所以排除三类——
 *   - `cycle`：我来过这一圈，不是推进（一天 25~30 圈，全算就是灌水；这正是 42 天
 *     「布线环没合上但履历很热闹」的原因）
 *   - `note`：备注
 *   - `checkpoint`：保存现场，不是改进现场
 * 剩下的五类都声称自己改变了什么：裁决改认知、炼化改技能、布线改规则、
 * 评测改版本、反思改判断。
 */
export const ADVANCE_TYPES: ReadonlySet<string> = new Set(['verdict', 'forge', 'wire', 'evolve', 'reflect'])

/**
 * 哪些动作**必须带证据指针**才算数。
 *
 * `evolve` 不在此列：评测轮的证据是 ledger 里的分数差，不由本字段承载。
 * `reflect` 不在此列：反思的证据是它引用的记忆/事件，通常已写在 detail 里。
 */
export const NEEDS_EVIDENCE: ReadonlySet<string> = new Set(['verdict', 'forge', 'wire'])

export interface ProgressSnapshot {
  /** 最近一次「推进」的时刻（ISO）；null = 从未推进过 */
  lastAdvanceAt: string | null
  /** 距上次推进的小时数；null = 从未推进过 */
  hoursSinceAdvance: number | null
  /** 最近 7 天的推进次数 */
  advanceCount7d: number
  /** 累计推进次数 */
  advanceTotal: number
  /** 累计带证据的推进次数 */
  creditedTotal: number
  /**
   * 最近**连续**多少条「需要证据」的推进**没带证据**（从最新往回数，遇到带证据的停）。
   *
   * ⚠ 这是**质量**读数，不参与「该不该推进」的判定——那是 `stale` 的事。
   * 分工：`stale` 回答「要不要动」，本字段回答「动了算不算数」。
   */
  creditlessStreak: number
  /** 距上次推进已超过阈值：本圈需要一次推进 */
  stale: boolean
  /** 阈值（小时），回显便于核对口径 */
  idleHours: number
}

/**
 * 从履历算推进读数。
 *
 * ⚠ 口径声明（读数三问的第三问）：只看 events 与 now，不看文件 mtime、不看别的器官——
 * 「推进」的唯一真源是 history.jsonl 里的事实。
 */
export function computeProgress(events: HistoryEvent[], now: Date, idleHours: number): ProgressSnapshot {
  const advances = events
    .filter((e) => ADVANCE_TYPES.has(e.type))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())

  const lastAdvanceAt = advances.length > 0 ? advances[0]!.ts : null
  const hoursSinceAdvance = lastAdvanceAt === null
    ? null
    : Math.max(0, (now.getTime() - new Date(lastAdvanceAt).getTime()) / 3600000)

  const cutoff = now.getTime() - 7 * 86400000
  const advanceCount7d = advances.filter((e) => new Date(e.ts).getTime() >= cutoff).length

  const evidenceOf = (e: HistoryEvent): string => {
    const v = (e as HistoryEvent & { evidence?: string }).evidence
    return typeof v === 'string' ? v.trim() : ''
  }
  const creditedTotal = advances.filter((e) => evidenceOf(e) !== '').length

  // 窗口（2026-11-02 实测修正）：不限窗口时这个数会把**全部历史**算进来——
  // 上线首日实测 `creditlessStreak=286`，其中 280 条是 30 天以前的老记录。
  // 「连续 286 条无证据」读起来像「最近连做 286 次都没带证据」，那是错的读数
  // （读数三问第一问：这个数说的是哪个域）。改成 7 天，与 `advanceCount7d` 同窗同口径。
  const creditCutoff = now.getTime() - 7 * 86400000
  let creditlessStreak = 0
  for (const e of advances) {
    if (new Date(e.ts).getTime() < creditCutoff) break
    if (!NEEDS_EVIDENCE.has(e.type)) continue
    if (evidenceOf(e) !== '') break
    creditlessStreak += 1
  }

  // 从未推进过也算 stale（否则新装插件永远等下去，与「缺省不是健康」同一条纪律）
  const stale = hoursSinceAdvance === null ? true : hoursSinceAdvance >= idleHours

  return {
    lastAdvanceAt,
    hoursSinceAdvance: hoursSinceAdvance === null ? null : Math.round(hoursSinceAdvance * 10) / 10,
    advanceCount7d,
    advanceTotal: advances.length,
    creditedTotal,
    creditlessStreak,
    stale,
    idleHours,
  }
}

/** 推进读数的单行人话（感知圈与每轮注入共用，口径单一） */
export function renderProgressLine(p: ProgressSnapshot): string {
  if (p.advanceTotal === 0) {
    return '从未推进（本圈必须产出一次：finding / wire / verdict 之一，且带证据指针）'
  }
  const h = p.hoursSinceAdvance === null ? '?' : String(p.hoursSinceAdvance)
  const tail = p.stale ? `≥${p.idleHours}h ⇒ 本圈必须推进` : '正常'
  const credit = p.creditlessStreak > 0 ? ` ｜ 连续 ${p.creditlessStreak} 条无证据` : ''
  return `${h}h 前推进（7 天 ${p.advanceCount7d} 次 · 累计 ${p.advanceTotal}）${credit} ｜ ${tail}`
}
