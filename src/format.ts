/**
 * dsh-evolution-core — 呈现/格式化纯层（零 IO，可离线单测）
 *
 * 器官行渲染 / 环状态标记 / 类型中文标签 / 天数窗口收敛 / 红环判定。
 * 判据 = 源码唯一真源：与原 index.ts 内实现逐字等价（只搬位置）。
 */
import type { OrganSnapshot, RingState } from './core.ts'

/** 历史事件类型 → 中文标签 */
export const TYPE_LABEL: Record<string, string> = {
  cycle: '感知圈', verdict: '裁决', forge: '炼化', evolve: '评测',
  wire: '布线', reflect: '反思', checkpoint: '存档', note: '备注',
}

/**
 * 渲染一行的器官状态（compact）
 *
 * `null` / `undefined` 与 `ok !== true` 同口径（`⚠不可读`）——判空不再只存在于调用方
 * （`aggregateSnapshot` 的 `organ === undefined ? ... : renderOrganLine(...)` 只是纵深防御）。
 */
export function renderOrganLine(key: string, o: OrganSnapshot | null | undefined): string {
  if (o === null || o === undefined || o.ok !== true) return `${key}: ⚠不可读`
  switch (key) {
    case 'selftest':
      return `selftest: 共${o.total} 活跃${o.active} finding${o.finding} ✓${o.confirmed} ✗${o.refuted}`
    case 'emotion':
      return `emotion: today=${o.today} 触发${o.triggerCount}次 工具${Array.isArray(o.statsKeys) ? o.statsKeys.length : 0}种`
    case 'reflection':
      return `reflection: 上次${o.lastTriggerDate} 共${o.triggerCount}次`
    case 'lifeCore':
      return `life-core: ${o.status} 今日${o.todayTurns}圈 周期${o.cycleMinutes}min`
    case 'memory':
      return `memory: 条目${o.entryCount}`
    case 'checkpoints':
      return `checkpoints: ${o.count}个 最近${o.latest ?? '—'}（${o.latestAgeDays ?? '?'}天前）`
    case 'evolve':
      return `evolve: ${o.generationCount}代 最近${o.lastGenAt ? String(o.lastGenAt).slice(0, 10) : '—'} 闲置${o.idleDays ?? '?'}天`
    default:
      return `${key}: ${JSON.stringify(o)}`
  }
}

/** 环状态 → 圆点标记 */
export function ringMark(state: string): string {
  return state === 'green' ? '🟢' : state === 'yellow' ? '🟡' : state === 'red' ? '🔴' : '⚪'
}

/** 履历查询窗口（天）：缺省 30，收敛到 [1, 3650] */
export function clampDays(days: number | undefined): number {
  return Math.min(Math.max(days ?? 30, 1), 3650)
}

/**
 * 是否存在红环断点
 *
 * 非数组（`null`/`undefined`/脏载荷）→ `false`，与本文件既有口径一致：
 * 「读不出的环项按非红处理（保守：不谎报红环）」——红环只由真实观测到的 `state === 'red'` 产生。
 * 环级不可读性由 `diagnoseRings` 的 `{state:'yellow', detail:'数据源不可读'}` 与器官行 `⚠不可读` 各自显式呈现。
 */
export function hasRedRing(rings: Array<Pick<RingState, 'state'>> | null | undefined): boolean {
  if (!Array.isArray(rings)) return false
  return rings.some((r) => r?.state === 'red')
}
