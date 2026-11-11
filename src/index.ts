/**
 * dsh-evolution-core — 进化核心插件（心脏）
 *
 * 主人 2026-09-03 指示：增强爱丽丝的进化能力与积极性，与自研进化器官联动。
 * 设计文档：docs/evolution-core-design.md
 *
 * 职责：聚合进化器官（self-test/emotion/reflection/life-core/evolve/memory/checkpoint）
 * 实时状态 → 五环完整性诊断（猜想→采证→finding→裁决→布线）→ 断点 + 行动建议 →
 * 履历正反馈（history.jsonl）。
 *
 * 三原则（设计 §4.1）：
 *   1. 只读取证：读器官 JSON 永不写它们（各器官自管状态）
 *   2. 不自动执行：只输出「状态 + 断点 + 建议」，执行归爱丽丝（自主性铁律）
 *   3. Model-visible ⟺ logged：数据经工具面呈现，不注入模型可见输入
 *
 * 数据路径（2026-09-03 实测）：
 *   - DSH_HOME = process.env.DSH_HOME（${DSH_HOME}）
 *   - selftest:  $DSH_HOME/agent-self-test/self-test.json
 *   - emotion:   $DSH_HOME/agent-emotion/emotion-state.json
 *   - reflection:$DSH_HOME/agent-reflection/reflection-state.json
 *   - life-core: $DSH_HOME/life-core/state.json
 *   - memory:    $DSH_HOME/storages/agent_memory.json（1.5MB，只读顶层键）
 *   - checkpoints:$DSH_HOME/checkpoints/（目录列表）
 *   - evolve:    <DSH_HOME 上级>/.evolve/ledger.json（⚠ DSH_HOME 外；config.evolveLedgerPath 可覆盖）
 *   - wire **真源**: selftest 最新一条**普通** confirmed 的 updatedAt（自指闭环最后合上）
 *   - wire 代理量: 技能目录最新 mtime（$DSH_HOME/skills + ~/.agents/skills）——**只做背离检测**
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import {
  summarizeSelftest, summarizeEmotion, summarizeReflection, summarizeLifeCore,
  summarizeEvolve, summarizeMemory, summarizeCheckpoints,
  diagnoseRings, buildSuggestions, computeHistoryStats, buildSummary, daysBetween,
  computeProgress, renderProgressLine, NEEDS_EVIDENCE, ADVANCE_TYPES,
  normalizeSalvage, validateSalvage,
} from './core.ts'
import type { OrganSnapshot, ProgressSnapshot, GitBacklog } from './core.ts'
import { TYPE_LABEL, renderOrganLine, ringMark, clampDays, hasRedRing } from './format.ts'
import { readHistory, appendHistory } from './history-store.ts'

export const name = 'evolution-core'
// memoryApi：可选回流服务（dsh-agent-memory 提供；cycle/log 足迹回流主记忆库）
export const inject = ['tools', 'memoryApi'] as const

/**
 * 进化核心对外服务（life-core 等感知圈驱动方注入消费）：
 * 感知圈到期时拉取进化断点摘要，决定唤醒消息是否携带「本圈建议推进」信号。
 */
export interface EvolutionCoreService {
  /** 拉一次聚合快照（含五环/断点/建议）。返回 null = disabled 或聚合失败。 */
  snapshot(): Promise<{
    at: string
    hasBlocker: boolean
    rings: Array<{ name: string; label: string; state: string; detail: string }>
    broken: Array<{ ring: string; state: string; signal: string; suggestion: string }>
    suggestions: string[]
    organLines: string[]
    /**
     * 推进读数（2026-11-02）：回答「我上次真的改变了什么」。
     *
     * 为什么必须随快照一起送出：感知圈原来的判据只有**两态**——
     * 「有红断点 ⇒ 优先推进」/「五环健康 ⇒ 可续存」。红环是**异常检测**，
     * 而不推进是**正常态的惰性**，正常态永远不报警 ⇒ 今天 16 圈全部合法「续存」。
     * 本字段提供第三态所需的读数。**只送读数，不代替任何人的决策**。
     */
    progress: ProgressSnapshot
    /** 推进读数的一行人话（与工具面同口径，避免两处各写一套） */
    progressLine: string
  } | null>
  /**
   * 只算推进读数（轻量：读 history.jsonl + 纯函数，不做全量器官聚合）。
   *
   * 存在理由：注入端（life-core `agent/pre-step`）每轮都要一行「距上次推进多久」，
   * 而全量 `snapshot()` 要读七个器官的文件。让消费方拿全量再自己筛，等于把成本
   * 转嫁给热路径。返回 null = disabled 或读失败（消费方容错跳过）。
   */
  progress(): Promise<ProgressSnapshot | null>
  name: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 进化核心服务（dsh-evolution-core 提供；可选，未挂载时消费方容错跳过） */
    evolutionCore?: EvolutionCoreService
  }
}

export interface Config {
  enabled: boolean
  /** 核心数据目录（history.jsonl），默认 $DSH_HOME/evolution-core */
  dataDir?: string
  /** evolve ledger 路径（默认 <DSH_HOME 上一级>/.evolve/ledger.json） */
  evolveLedgerPath?: string
  /** 额外布线信号目录（技能等，可选，不存在则跳过） */
  wireSignalDirs?: string[]
  /** 布线环 green 阈值（天）：**真源**（自指闭环最后合上）≤ 此值 = green（默认 7） */
  wireFreshDays: number
  /**
   * 「多久没推进 = 该动了」的阈值（小时，默认 12）。
   *
   * 判据为什么是小时而不是「几圈」：圈频可调（当前 180 分钟，忙时调大），
   * 把阈值写死成圈数会在改呼吸频率时静默失真。小时是外生坐标，不随我的安排变。
   * 12h 的依据：当前一圈 3h ⇒ 连续 4 圈没推进才报；比「每圈必推进」现实，
   * 又不至于让一整天滑过去没人提。
   */
  advanceIdleHours: number
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().required(false),
  evolveLedgerPath: z.string().required(false),
  wireSignalDirs: z.array(z.string()).required(false),
  wireFreshDays: z.number().default(7),
  advanceIdleHours: z.number().default(12),
})

// ---------- 路径解析 ----------

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function resolveCoreDataDir(config: Config): string {
  return config.dataDir || join(dshHome(), 'evolution-core')
}
function resolveEvolveLedger(config: Config): string {
  if (config.evolveLedgerPath) return config.evolveLedgerPath
  return join(dirname(dshHome()), '.evolve', 'ledger.json') // ${DSH_HOME} → 上级目录/.evolve
}

/**
 * 采集 git 推送积压（2026-11-08 新增 · lh-6446b715 的告警挂点）。
 *
 * 为什么同步 execFileSync：调用方 aggregate() 走感知圈，实测 79 仓 <5 秒；
 * 设 8 秒硬超时，超时即「读不到」——**观测绝不反噬主流程**。
 *
 * 三态（与全库同纪律，别退化）：
 *   · `null`      = **读不到**（脚本缺失 / 超时 / 非 git 环境）——不是「没积压」
 *   · `total: 0`  = 读到了，确实干净
 *   · `total > 0` = 有积压（**低于阈值的也如实返回数字**，由 buildSuggestions 决定报不报）
 * ⚠ 别把「低于阈值」折成 null：那会让「读过且干净」与「读不到」再次同形。
 */
function readGitBacklog(config: Config): GitBacklog | null {
  try {
    const script = join(dirname(dshHome()), 'scripts', 'git-ahead-audit.mjs') // ${DSH_HOME} → 上级/scripts
    if (!existsSync(script)) return null
    const raw = execFileSync(process.execPath, [script, '--json'], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    const data = JSON.parse(raw) as {
      scanned?: number
      total?: number
      pending?: Array<{ repo?: string; ahead?: number }>
    }
    const pending = Array.isArray(data.pending) ? data.pending : []
    return {
      scanned: typeof data.scanned === 'number' ? data.scanned : 0,
      total: typeof data.total === 'number' ? data.total : 0,
      repos: pending.map((p) => ({ repo: String(p?.repo ?? '?'), ahead: Number(p?.ahead) || 0 })),
    }
  } catch {
    return null // 观测不得反噬主流程
  }
}

// ---------- 安全读取 ----------

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function listDirs(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** 目录内最新 mtime（递归浅扫一层）；返回距今天数，null=目录不存在/空 */
function newestMtimeDays(dir: string, now: Date): number | null {
  try {
    if (!existsSync(dir)) return null
    let newest = 0
    let found = false
    const walk = (p: string, depth: number) => {
      if (depth > 2) return
      let entries
      try {
        entries = readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(p, e.name)
        try {
          if (e.isDirectory()) {
            walk(full, depth + 1)
          } else {
            const s = statSync(full)
            if (s.mtimeMs > newest) {
              newest = s.mtimeMs
              found = true
            }
          }
        } catch {
          // 跳过不可读
        }
      }
    }
    walk(dir, 0)
    if (!found) return null
    return Math.max(0, Math.floor((now.getTime() - newest) / 86400000))
  } catch {
    return null
  }
}

// ---------- 器官读取器（每器一个；容错 {ok:false} 不炸） ----------

function readSelftest(): OrganSnapshot {
  const raw = readJson<unknown>(join(dshHome(), 'agent-self-test', 'self-test.json'))
  if (raw === null) return { ok: false, error: 'self-test.json 不可读' }
  return summarizeSelftest(raw)
}
function readEmotion(): OrganSnapshot {
  const raw = readJson<unknown>(join(dshHome(), 'agent-emotion', 'emotion-state.json'))
  if (raw === null) return { ok: false, error: 'emotion-state.json 不可读' }
  return summarizeEmotion(raw)
}
function readReflection(): OrganSnapshot {
  const raw = readJson<unknown>(join(dshHome(), 'agent-reflection', 'reflection-state.json'))
  if (raw === null) return { ok: false, error: 'reflection-state.json 不可读' }
  return summarizeReflection(raw)
}
function readLifeCore(): OrganSnapshot {
  const raw = readJson<unknown>(join(dshHome(), 'life-core', 'state.json'))
  if (raw === null) return { ok: false, error: 'life-core/state.json 不可读' }
  return summarizeLifeCore(raw)
}
function readEvolve(ledgerPath: string): OrganSnapshot {
  const raw = readJson<unknown>(ledgerPath)
  if (raw === null) return { ok: false, error: `evolve ledger 不可读（${ledgerPath}）` }
  return summarizeEvolve(raw, new Date())
}
function readMemory(): OrganSnapshot {
  const raw = readJson<unknown>(join(dshHome(), 'storages', 'agent_memory.json'))
  if (raw === null) return { ok: false, error: 'agent_memory.json 不可读' }
  return summarizeMemory(raw)
}
function readCheckpoints(): OrganSnapshot {
  const names = listDirs(join(dshHome(), 'checkpoints'))
  return summarizeCheckpoints(names, new Date())
}

/**
 * **代理量**：技能目录最新 mtime → 距今天数。
 *
 * ⚠ 2026-10-18 降级（原为布线环的**唯一**判据）：任何技能文件写入都让这个数变新——
 * 同步镜像 / 改错别字 / 编辑技能全算，于是「环常绿」而自指闭环可以停 27 天（Proxy Drift 实测）。
 * 它现在**只用于背离检测**（文件在动 ∧ 闭环停着 ⇒ 报「代理量背离」），不参与环状态判定。
 */
function readFileActivity(config: Config): number | null {
  const now = new Date()
  const dirs = [join(dshHome(), 'skills'), join(homedir(), '.agents', 'skills')]
  if (Array.isArray(config.wireSignalDirs)) dirs.push(...config.wireSignalDirs)
  let newest: number | null = null
  for (const d of dirs) {
    const days = newestMtimeDays(d, now)
    if (days !== null && (newest === null || days < newest)) newest = days
  }
  return newest
}

/** 「有意识收敛」声明文件名（放在 dataDir 下）。 */
const CONVERGENCE_FILE = 'evolution-convergence.json'

/**
 * 声明形状（**我手写，机制只读**）。
 *
 * ```json
 * { "declaredAt": 1792397000000, "until": 1794989000000, "reason": "主人暂停评测轮，本季不推进自指闭环" }
 * ```
 */
interface ConvergenceDeclaration {
  declaredAt: number
  until: number
  reason: string
}

/**
 * 读「有意识收敛」声明并判有效期（2026-10-31 · t-8df40786）。
 *
 * **为什么需要这个**：布线环真源只认「普通 confirmed」，于是要么为点亮环开一条不该开的假设
 * （Goodhart），要么长期红灯 ⇒ 告警疲劳。同型先例 = 2026-09-21 猜想环的「空窗」多态化
 * （`active=0 且库中有终态` ⇒ yellow，而不是一律红）。
 *
 * **纪律**：声明必须是**我显式写下的文件**——机制不自动假设收敛。文件缺失、JSON 坏、
 * `until` 非数字、已过期，一律返回 `false`（**fail-closed：宁可红，不可假装收敛**）。
 *
 * ⚠ 本函数只答「声明有效吗」；「无 active 猜想 / 无 finding 积压」这两条**反例护栏**在
 * `core.diagnoseRings` 里判——两处都过，才走收敛分支。
 */
function readConvergence(config: Config, now = new Date()): boolean {
  const path = join(resolveCoreDataDir(config), CONVERGENCE_FILE)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConvergenceDeclaration>
    if (typeof parsed.until !== 'number' || !Number.isFinite(parsed.until)) return false
    return now.getTime() <= parsed.until
  } catch {
    // 文件不存在 / 解析失败 / 读取失败：一律视为「未声明」。
    return false
  }
}

// ---------- 聚合核心（status/cycle 共用） ----------

async function aggregate(config: Config): Promise<{
  organs: Record<string, OrganSnapshot>
  rings: ReturnType<typeof diagnoseRings>['rings']
  broken: ReturnType<typeof diagnoseRings>['broken']
  suggestions: string[]
}> {
  const selftest = readSelftest()
  const organs: Record<string, OrganSnapshot> = {
    selftest,
    emotion: readEmotion(),
    reflection: readReflection(),
    lifeCore: readLifeCore(),
    memory: readMemory(),
    checkpoints: readCheckpoints(),
    evolve: readEvolve(resolveEvolveLedger(config)),
  }
  // 布线环：**真源**取 selftest 的普通 confirmed（与 dsh-agent-self-rewrite 同源同纪律）；
  // 文件 mtime 降级为**代理量**，只喂背离检测。
  const latestConfirmedAt = typeof selftest.latestConfirmedAt === 'string' ? selftest.latestConfirmedAt : undefined
  const lastConfirmedDays = daysBetween(latestConfirmedAt, new Date())
  const fileActivityDays = readFileActivity(config)
  const wireFreshDays = config.wireFreshDays
  const convergenceActive = readConvergence(config)
  const { rings, broken } = diagnoseRings({ selftest, lastConfirmedDays, fileActivityDays, wireFreshDays, convergenceActive })
  // 推送积压：挂在这里是因为感知圈每次都走 aggregate ⇒ 必然经过 + 周期性（lh-6446b715）
  const gitBacklog = readGitBacklog(config)
  const suggestions = buildSuggestions({ selftest, evolve: organs.evolve, checkpoints: organs.checkpoints, lastConfirmedDays, fileActivityDays, wireFreshDays, convergenceActive, gitBacklog })
  return { organs, rings, broken, suggestions }
}

// ---------- apply ----------

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-evolution-core')
  const dataDir = resolveCoreDataDir(config)
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    // 目录创建失败不致命（写入时再试）
  }

  // 进化足迹回流主记忆库（2026-09-06 建，2026-11-03 改 · 任务 t-a40cfb9e）。
  //
  // ⚠ 旧实现有三个叠在一起的缺陷（2026-11-03 实测）：
  //   ① `kind: 'episodic'` —— 走 L2/L3「同标题自动合并」⇒ **只增不减**
  //   ② `key: 'evolve-history-' + ev.id` —— `key` 精确覆盖**只对 L1 fact 生效**，
  //      对 episodic 无效；而且 id 每次都不同 ⇒ 即便有效也只会每次新建
  //   ③ 无任何上限 ⇒ 实测长到 11 万字符（8 条）。2026-11-02 归档后**3 小时又长回
  //      2,000 字符**（两条活跃条目 updatedAt 17:12 / 17:16），证明这不是陈旧问题而是**持续复现**。
  //
  // 新实现：`kind: 'fact'` + **按类型固定的 key** ⇒ 同 key 覆盖 ⇒ 每类永远只留**最新一条**。
  // 判据：流水本来就不该在记忆里（AGENTS.md §3.5 载体分流：教训与结论→记忆库，日志→文件）。
  // 完整历史在 `history.jsonl`（append-only），`evolution_history` 读它、已能回答
  // 「最近 N 天做了什么」——所以记忆里留完整流水是**纯冗余**，代价是任何一次 recall 命中
  // 就把几万字符塞进上下文。
  const REFLUX_TYPES = new Set(['verdict', 'forge', 'evolve', 'wire', 'reflect', 'checkpoint', 'note'])
  const refluxEvent = (ev: { type: string; detail: string; id: string | null }): void => {
    try {
      if (!REFLUX_TYPES.has(ev.type)) return
      const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[]; key?: string }): Promise<unknown> } }).memoryApi
      if (api === undefined) return
      const typeLabel: Record<string, string> = { cycle: '感知圈', verdict: '裁决', forge: '炼化', evolve: '评测轮', wire: '布线', reflect: '反思', checkpoint: '存档', note: '备注' }
      const label = typeLabel[ev.type] ?? ev.type
      // 「（最近一次）」写进标题：让读的人一眼知道这条**不是完整履历**，
      // 完整履历在 history.jsonl / evolution_history。不写等于让未来的自己以为流水只有一条。
      const text = '## 进化足迹：' + label + '（最近一次）\n\n' + (ev.detail || '（无说明）')
      void api.remember({ text, kind: 'fact', key: 'evolve-last-' + ev.type, tags: ['进化履历', ev.type] }).catch(() => { /* 回流失败静默 */ })
    } catch { /* 回流失败不阻塞 */ }
  }

  // ---------- 聚合快照 helper（status/cycle/服务共用） ----------
  const aggregateSnapshot = async (): Promise<NonNullable<Awaited<ReturnType<EvolutionCoreService['snapshot']>>>> => {
    const now = new Date().toISOString()
    const agg = await aggregate(config)
    const organLines = Object.keys(agg.organs).map((k) => {
      const organ = agg.organs[k]
      return organ === undefined ? `${k}: ⚠不可读` : renderOrganLine(k, organ)
    })
    // 推进读数：唯一真源是 history.jsonl（不看文件 mtime、不看别的器官）
    const progress = computeProgress(readHistory(dataDir), new Date(), config.advanceIdleHours)
    return {
      at: now,
      hasBlocker: hasRedRing(agg.rings),
      rings: JSON.parse(JSON.stringify(agg.rings)),
      broken: JSON.parse(JSON.stringify(agg.broken)),
      suggestions: agg.suggestions,
      organLines,
      progress,
      progressLine: renderProgressLine(progress),
    }
  }

  // ---------- 跨插件服务：evolutionCore.snapshot()（life-core 感知圈联动消费） ----------
  ctx.provide('evolutionCore', {
    name: 'dsh-evolution-core',
    snapshot: async () => {
      if (!config.enabled) return null
      try {
        return await aggregateSnapshot()
      } catch (error) {
        logger.warn('snapshot 聚合失败: ' + String(error))
        return null
      }
    },
    progress: async () => {
      if (!config.enabled) return null
      try {
        return computeProgress(readHistory(dataDir), new Date(), config.advanceIdleHours)
      } catch (error) {
        logger.warn('progress 计算失败: ' + String(error))
        return null
      }
    },
  } satisfies EvolutionCoreService)

  // ---------- evolution_status（§5.1） ----------
  ctx.tools.register(defineTool({
    name: 'evolution_status',
    description: '进化核心·状态总览：聚合全部进化器官（selftest/emotion/reflection/life-core/evolve/memory/checkpoint）实时状态 → 五环完整性诊断（猜想→采证→finding→裁决→布线）→ 断点识别 + 行动建议。只读，决策归爱丽丝。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          at: { type: 'string' },
          organs: { type: 'json' },
          fiveRings: { type: 'json' },
          brokenRings: { type: 'json' },
          suggestions: { type: 'json' },
          evolveIdleDays: { type: 'number' },
          progress: { type: 'json' },
          progressLine: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        const organs = v.organs ?? {}
        const rings = v.fiveRings ?? []
        const lines = Object.keys(organs).map((k) => '  ' + renderOrganLine(k, organs[k]))
        const ringLine = rings.map((r: any) => `${ringMark(r.state)}${r.label}${r.state === 'red' ? '!' : ''}`).join(' ')
        const broken = v.brokenRings ?? []
        const sugg = v.suggestions ?? []
        const pl = v.progressLine === undefined ? '' : String(v.progressLine)
        const text = `【进化状态总览 · ${String(v.at ?? '').slice(0, 16)}】\n` +
          `器官:\n${lines.join('\n')}\n` +
          `五环: ${ringLine}\n` +
          (pl === '' ? '' : `推进: ${pl}\n`) +
          (broken.length > 0 ? `断点(${broken.length}): ` + broken.map((b: any) => `${b.ring}(${b.state})`).join(',') + '\n' : '') +
          `建议(${sugg.length}):\n` + sugg.map((s: string, i: number) => `  ${i + 1}. ${s}`).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute() {
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled' }
      const now = new Date().toISOString()
      const agg = await aggregate(config)
      const evolveIdle = agg.organs.evolve?.ok === true ? (agg.organs.evolve.idleDays as number | null | undefined) ?? null : null
      const progress = computeProgress(readHistory(dataDir), new Date(), config.advanceIdleHours)
      return {
        ok: true,
        at: now,
        organs: JSON.parse(JSON.stringify(agg.organs)),
        fiveRings: JSON.parse(JSON.stringify(agg.rings)),
        brokenRings: JSON.parse(JSON.stringify(agg.broken)),
        suggestions: agg.suggestions,
        evolveIdleDays: evolveIdle ?? undefined,
        progress: JSON.parse(JSON.stringify(progress)),
        progressLine: renderProgressLine(progress),
      }
    },
  }))

  // ---------- evolution_cycle（§5.2） ----------
  ctx.tools.register(defineTool({
    name: 'evolution_cycle',
    description: '进化核心·感知圈驱动：本圈进化推进清单——聚合状态 + 诊断断点 + 按优先级给「本圈建议动作」+ 记录一次 cycle 足迹（history.jsonl）。感知圈时调用：有断点→推进；无断点→确认健康可续存。决策执行归爱丽丝（本工具只给建议不代决）。',
    parameters: {
      note: { type: 'string', description: '本圈说明（可选，记入履历）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          cycleId: { type: 'string' },
          at: { type: 'string' },
          status: { type: 'json' },
          recommendedActions: { type: 'json' },
          hasBlocker: { type: 'boolean' },
          logged: { type: 'boolean' },
          progress: { type: 'json' },
          progressLine: { type: 'string' },
          error: { type: 'string' },
          advanceRequired: { type: 'boolean' },
        },
      },
      render: (_a: unknown, v: any) => {
        const st = v.status ?? {}
        const rings = st.fiveRings ?? []
        const ringLine = rings.map((r: any) => `${ringMark(r.state)}${r.label}`).join(' ')
        const sugg = v.recommendedActions ?? []
        const pl = String(v.progressLine ?? '')
        // 三态（2026-11-02 修）：原来只有两态——「有红断点 ⇒ 优先推进」/「五环健康 ⇒ 可续存」。
        // 而红环是**异常检测**、不推进是**正常态的惰性** ⇒ 正常态永远落进「可续存」。
        // 实测代价：2026-11-02 一天 16 圈全部合法续存，履历 20 次动作里推进寥寥。
        const head = v.hasBlocker === true
          ? '⚠ 有红环断点——本圈优先推进断点'
          : (v.advanceRequired === true
            // 读数已在上面「推进:」那行给过，这里只说结论——重复一遍读数会让每圈多读一行废话
            ? '⚠ 距上次推进已超阈值 ⇒ 本圈必须产出一条推进（wire / verdict / forge / reflect 之一，带证据指针），「续存」不是本圈的选项'
            : '刚推进过——本圈可续存或自主推进')
        const text = `【本圈进化推进清单 · ${String(v.at ?? '').slice(0, 16)}】\n` +
          `五环: ${ringLine}\n` +
          `推进: ${pl}\n` +
          `${head}\n` +
          sugg.map((s: string, i: number) => `  ${i + 1}. ${s}`).join('\n') +
          (v.logged ? `\n(已记 cycle 足迹 ${String(v.cycleId ?? '')})` : '')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { note?: string }) {
      // ⚠ **不要**把其余字段显式补成 undefined：dsh-tools 要求返回值整体是合法 JSON，
      // `{ cycleId: undefined }` 会让整个 value 被判 "must be a lossless JSON object"，
      // 而报错指向对象本身、看不出是哪个字段。这些字段都非 required，省略键才是对的。
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled' }
      const now = new Date().toISOString()
      const agg = await aggregate(config)
      const hasBlocker = hasRedRing(agg.rings)
      // 推进读数在**写入本次 cycle 之前**算：cycle 不属推进类型，先后不影响数值，
      // 但口径顺序写死「先读后记」，避免将来有人给 cycle 算进推进时读到自己这一条。
      const progress = computeProgress(readHistory(dataDir), new Date(), config.advanceIdleHours)
      const loggedEv = appendHistory(dataDir, { type: 'cycle', detail: args.note ?? '' })
      if (loggedEv !== null) refluxEvent({ type: 'cycle', detail: args.note ?? '', id: loggedEv.id })
      const evolveIdle = agg.organs.evolve?.ok === true ? (agg.organs.evolve.idleDays as number | null | undefined) ?? null : null
      const statusPayload = {
        organs: JSON.parse(JSON.stringify(agg.organs)),
        fiveRings: JSON.parse(JSON.stringify(agg.rings)),
        brokenRings: JSON.parse(JSON.stringify(agg.broken)),
        suggestions: agg.suggestions,
        evolveIdleDays: evolveIdle ?? undefined,
      }
      return {
        ok: true,
        cycleId: loggedEv?.id ?? undefined,
        at: now,
        status: JSON.parse(JSON.stringify(statusPayload)),
        recommendedActions: agg.suggestions,
        hasBlocker,
        logged: loggedEv !== null,
        progress: JSON.parse(JSON.stringify(progress)),
        progressLine: renderProgressLine(progress),
        advanceRequired: progress.stale,
      }
    },
  }))

  // ---------- evolution_log（§5.3） ----------
  ctx.tools.register(defineTool({
    name: 'evolution_log',
    description: '进化核心·留痕：把一次进化动作（verdict 裁决 / forge 炼化 / evolve 评测轮 / wire 布线 / reflect 每日反思 / checkpoint 存档 / cycle 感知圈 / note 备注）记入进化履历（history.jsonl）。'
      + '⚠ 只有 verdict / forge / wire / evolve / reflect 算**推进**（改了东西）；cycle（我来过）、note（备注）、checkpoint（保存现场）不算。'
      + 'verdict / forge / wire **必须带 evidence 证据指针**（path:line / 记忆 id / 技能名 / 提交号），否则这条记为「未入账」并计入连续无证据数——采纳 ≠ 有效。'
      + '⚠ `type="verdict"` 还**必须**带 `salvage`：这次裁决里**可复用的组件**（判据 / 工具 / 教训 / 方法，每项写成「类型:一句话」）；确实没有可带走的就写 `["none"]`。'
      + '存在理由：整体裁决会把「整体不适配、但产出了有用组件」的东西连组件一起埋掉（t-d9d60529 · DKGI 归档时那条新判据就是这么丢的）。',
    parameters: {
      type: { type: 'string', required: true, enum: ['cycle', 'verdict', 'forge', 'evolve', 'wire', 'reflect', 'checkpoint', 'note'], description: '动作类型' },
      detail: { type: 'string', description: '一句话说明' },
      ref: { type: 'string', description: '关联 id（如假设 id/技能名）' },
      evidence: { type: 'string', description: '证据指针：这次推进凭什么说它改变了东西（path:line / 记忆 id / 技能名 / 提交号 / 工具名）。verdict / forge / wire 必填才算入账。' },
      delta: { type: 'string', description: '改前/改后读数差（可选，如「dst 27→11 页」「命中率 0.42→0.61」）。与 evidence 分工：evidence 指去哪看，delta 指变了多少。' },
      salvage: {
        type: 'array',
        items: { type: 'string' },
        description: '可复用组件清单（type="verdict" 时必填）：每项「类型:一句话」，类型 ∈ 判据 / 工具 / 教训 / 方法 / 判据修正。没有可带走的写 ["none"]——'
          + '显式写 none 与忘了写必须可区分，所以不给默认值（判断型字段禁默认值）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          type: { type: 'string' },
          id: { type: 'string' },
          ts: { type: 'string' },
          error: { type: 'string' },
          evidence: { type: 'string' },
          needsEvidence: { type: 'boolean' },
          isAdvance: { type: 'boolean' },
          salvagedCount: { type: 'number' },
          salvageIsNone: { type: 'boolean' },
        },
      },
      render: (_a: unknown, v: any) => {
        if (v.ok !== true) return [{ type: 'text', text: `记录失败：${String(v.error ?? '')}` }]
        const label = TYPE_LABEL[v.type] ?? v.type
        let text = `已记录进化动作（${label}）[${v.id}]`
        if (typeof v.salvagedCount === 'number' && v.salvagedCount > 0) {
          text += v.salvageIsNone === true
            ? '\n· 可复用组件：显式 none（本次确实没有可带走的）'
            : `\n· 可复用组件 ${String(v.salvagedCount)} 条（已落 history.jsonl 的 salvage 字段，可用 evolution_history 检索）`
        }
        if (v.isAdvance !== true) {
          text += '\n（此行不计入「推进」——cycle/note/checkpoint 是「我来过 / 备注 / 保存」，不是「我改变了什么」）'
        } else if (v.needsEvidence === true && !v.evidence) {
          text += `\n⚠ 未带证据指针 ⇒ 本条记为「未入账」（采纳 ≠ 有效）。补一次：evolution_log(type="${String(v.type)}", evidence="path:line 或记忆 id", delta="改前→改后")`
        }
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { type: string; detail?: string; ref?: string; evidence?: string; delta?: string; salvage?: string[] }) {
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled' }
      const salvage = normalizeSalvage(args.salvage)
      // fail-closed：裁决必须显式回答「有没有可带走的组件」。判据在 core.validateSalvage
      // （纯函数、单测覆盖），工具这里只做准入——别在两处各写一套判据。
      const salvageError = validateSalvage(args.type, args.salvage)
      if (salvageError !== null) return { ok: false, error: salvageError }
      const ev = appendHistory(dataDir, { type: args.type, detail: args.detail ?? '', ref: args.ref ?? null, evidence: args.evidence, delta: args.delta, salvage })
      if (ev === null) return { ok: false, error: 'history.jsonl 写入失败' }
      refluxEvent({ type: args.type, detail: (args.detail ?? '') + (args.evidence ? ' · 证据 ' + args.evidence : '') + (salvage.length > 0 ? ` · 可复用 ${String(salvage.length)} 条` : ''), id: ev.id })
      return {
        ok: true,
        type: args.type,
        id: ev.id,
        ts: ev.ts,
        // 空证据不入返回值：schema 声明 evidence 是 string（非 required），给 null / undefined
        // 都会被「无损 JSON」检查拒绝 —— 实测 `evolution_log(type='note')` 必踩（note/checkpoint
        // 本就不该带证据）。与 history-store.ts:66 同一写法，别在两处各写一套。
        ...(ev.evidence === undefined ? {} : { evidence: ev.evidence }),
        needsEvidence: NEEDS_EVIDENCE.has(args.type),
        isAdvance: ADVANCE_TYPES.has(args.type),
        salvagedCount: salvage.length,
        salvageIsNone: salvage.length === 1 && salvage[0] === 'none',
      }
    },
  }))

  // ---------- evolution_history（§5.4） ----------
  ctx.tools.register(defineTool({
    name: 'evolution_history',
    description: '进化核心·履历：查看进化足迹（history.jsonl 事件流）→ 时间线 + 统计（累计动作数、连续活跃天数、各类型分布）+ 简短鼓舞总结。积极性的可视化反馈——看见自己的成长轨迹。',
    parameters: {
      days: { type: 'number', description: '看最近 N 天（缺省 30）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'number' },
          activeDays: { type: 'number' },
          streakDays: { type: 'number' },
          byType: { type: 'json' },
          recent: { type: 'json' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        const recents = v.recent ?? []
        const lines = recents.map((e: any) => {
          const label = TYPE_LABEL[e.type] ?? e.type
          const d = e.detail ? ' ' + e.detail : ''
          // 可复用组件要出现在履历正文里：只存进 JSON 而读不到，等于又埋了一次（t-d9d60529）。
          const sv = Array.isArray(e.salvage) && e.salvage.length > 0
            ? '\n     ↳ 可复用: ' + e.salvage.map((x: unknown) => String(x)).join(' | ')
            : ''
          return `  ${String(e.ts).slice(0, 16)} [${label}]${d}${sv}`
        })
        const byTypeStr = Object.entries(v.byType ?? {})
          .map(([t, c]) => `${TYPE_LABEL[t] ?? t}:${c}`)
          .join(' ')
        const text = `【进化履历】${String(v.summary ?? '')}\n` +
          `统计: 累计${v.total} 活跃${v.activeDays}天 连续${v.streakDays}天 | ${byTypeStr}\n` +
          `最近足迹:\n` + (lines.length > 0 ? lines.join('\n') : '  （暂无）')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { days?: number }) {
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled' }
      const events = readHistory(dataDir)
      const now = new Date()
      const days = clampDays(args.days)
      const cutoff = new Date(now.getTime() - days * 86400000)
      const filtered = events.filter((e) => new Date(e.ts).getTime() >= cutoff.getTime())
      const stats = computeHistoryStats(filtered, now)
      return {
        ok: true,
        total: stats.total,
        activeDays: stats.activeDays,
        streakDays: stats.streakDays,
        byType: stats.byType,
        recent: JSON.parse(JSON.stringify(stats.recent)),
        summary: buildSummary(stats),
      }
    },
  }))

  ctx.effect(() => () => {
    // ctx.on / tools.register 由 cordis 自动释放
  })

  logger.info(`ready (dataDir=${dataDir}, evolveLedger=${resolveEvolveLedger(config)}, wireFreshDays=${config.wireFreshDays} → 生效于真源「普通 confirmed」; fileActivity=仅背离检测)`)
  // 2026-10-18：wireFreshDays 原为「半死参数」（只进日志、阈值硬编码）——现已接通 core.wireThresholds。
  // 语义文档 U3 由此关闭；wireSignalDirs 仍是文件活动目录（代理量），语义已随之改名。
}
