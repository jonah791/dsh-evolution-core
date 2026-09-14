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
 *   - wire 代理: 技能目录最新 mtime（$DSH_HOME/skills + 工作区 ~/.agents/skills）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  summarizeSelftest, summarizeEmotion, summarizeReflection, summarizeLifeCore,
  summarizeEvolve, summarizeMemory, summarizeCheckpoints,
  diagnoseRings, buildSuggestions, computeHistoryStats, buildSummary,
} from './core.ts'
import type { OrganSnapshot } from './core.ts'
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
  } | null>
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
  /** 布线判定阈值：最近布线距今天数 ≤ 此值 = green（默认 7） */
  wireFreshDays: number
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().required(false),
  evolveLedgerPath: z.string().required(false),
  wireSignalDirs: z.array(z.string()).required(false),
  wireFreshDays: z.number().default(7),
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

/** 布线信号：技能目录（核心目录 + 配置附加目录）最新 mtime → 距今天数 */
function readWireSignal(config: Config): number | null {
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
  const lastWireDays = readWireSignal(config)
  const { rings, broken } = diagnoseRings({ selftest, lastWireDays })
  const suggestions = buildSuggestions({ selftest, evolve: organs.evolve, checkpoints: organs.checkpoints, lastWireDays })
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

  // 进化足迹回流主记忆库（2026-09-06）：cycle/log 写入 history.jsonl 的同时回流记忆（memoryApi 可选，不可用静默）。
  const refluxEvent = (ev: { type: string; detail: string; id: string | null }): void => {
    try {
      const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[]; key?: string }): Promise<unknown> } }).memoryApi
      if (api === undefined) return
      const typeLabel: Record<string, string> = { cycle: '感知圈', verdict: '裁决', forge: '炼化', evolve: '评测轮', wire: '布线', reflect: '反思', checkpoint: '存档', note: '备注' }
      const text = '## 进化足迹：' + (typeLabel[ev.type] ?? ev.type) + '\n\n' + (ev.detail || '（无说明）')
      void api.remember({ text, kind: 'episodic', tags: ['进化履历', ev.type], key: 'evolve-history-' + ev.id }).catch(() => { /* 回流失败静默 */ })
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
    return {
      at: now,
      hasBlocker: hasRedRing(agg.rings),
      rings: JSON.parse(JSON.stringify(agg.rings)),
      broken: JSON.parse(JSON.stringify(agg.broken)),
      suggestions: agg.suggestions,
      organLines,
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
        },
      },
      render: (_a: unknown, v: any) => {
        const organs = v.organs ?? {}
        const rings = v.fiveRings ?? []
        const lines = Object.keys(organs).map((k) => '  ' + renderOrganLine(k, organs[k]))
        const ringLine = rings.map((r: any) => `${ringMark(r.state)}${r.label}${r.state === 'red' ? '!' : ''}`).join(' ')
        const broken = v.brokenRings ?? []
        const sugg = v.suggestions ?? []
        const text = `【进化状态总览 · ${String(v.at ?? '').slice(0, 16)}】\n` +
          `器官:\n${lines.join('\n')}\n` +
          `五环: ${ringLine}\n` +
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
      return {
        ok: true,
        at: now,
        organs: JSON.parse(JSON.stringify(agg.organs)),
        fiveRings: JSON.parse(JSON.stringify(agg.rings)),
        brokenRings: JSON.parse(JSON.stringify(agg.broken)),
        suggestions: agg.suggestions,
        evolveIdleDays: evolveIdle ?? undefined,
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
        },
      },
      render: (_a: unknown, v: any) => {
        const st = v.status ?? {}
        const rings = st.fiveRings ?? []
        const ringLine = rings.map((r: any) => `${ringMark(r.state)}${r.label}`).join(' ')
        const sugg = v.recommendedActions ?? []
        const head = v.hasBlocker ? '⚠ 有红环断点——本圈建议优先推进' : '五环健康——本圈可续存或自主推进'
        const text = `【本圈进化推进清单 · ${String(v.at ?? '').slice(0, 16)}】\n` +
          `五环: ${ringLine}\n` +
          `${head}\n` +
          sugg.map((s: string, i: number) => `  ${i + 1}. ${s}`).join('\n') +
          (v.logged ? `\n(已记 cycle 足迹 ${String(v.cycleId ?? '')})` : '')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { note?: string }) {
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled', cycleId: undefined, at: undefined, status: undefined, recommendedActions: undefined, hasBlocker: false, logged: false }
      const now = new Date().toISOString()
      const agg = await aggregate(config)
      const hasBlocker = hasRedRing(agg.rings)
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
      }
    },
  }))

  // ---------- evolution_log（§5.3） ----------
  ctx.tools.register(defineTool({
    name: 'evolution_log',
    description: '进化核心·留痕：把一次进化动作（verdict 裁决 / forge 炼化 / evolve 评测轮 / wire 布线 / reflect 每日反思 / checkpoint 存档 / cycle 感知圈 / note 备注）记入进化履历（history.jsonl）。供 evolution_history 展示成长足迹（积极性正反馈）。',
    parameters: {
      type: { type: 'string', required: true, enum: ['cycle', 'verdict', 'forge', 'evolve', 'wire', 'reflect', 'checkpoint', 'note'], description: '动作类型' },
      detail: { type: 'string', description: '一句话说明' },
      ref: { type: 'string', description: '关联 id（如假设 id/技能名）' },
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
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? `已记录进化动作（${TYPE_LABEL[v.type] ?? v.type}）[${v.id}]` : `记录失败：${String(v.error ?? '')}` }],
    },
    async execute(args: { type: string; detail?: string; ref?: string }) {
      if (!config.enabled) return { ok: false, error: 'evolution-core disabled' }
      const ev = appendHistory(dataDir, { type: args.type, detail: args.detail ?? '', ref: args.ref ?? null })
      if (ev === null) return { ok: false, error: 'history.jsonl 写入失败' }
      refluxEvent({ type: args.type, detail: args.detail ?? '', id: ev.id })
      return { ok: true, type: args.type, id: ev.id, ts: ev.ts }
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
        },
      },
      render: (_a: unknown, v: any) => {
        const recents = v.recent ?? []
        const lines = recents.map((e: any) => {
          const label = TYPE_LABEL[e.type] ?? e.type
          const d = e.detail ? ' ' + e.detail : ''
          return `  ${String(e.ts).slice(0, 16)} [${label}]${d}`
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

  logger.info(`ready (dataDir=${dataDir}, evolveLedger=${resolveEvolveLedger(config)}, wireFreshDays=${config.wireFreshDays})`)
}
