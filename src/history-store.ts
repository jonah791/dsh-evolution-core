/**
 * dsh-evolution-core — 履历 IO 薄壳（history.jsonl）
 *
 * 追加/读取进化足迹；任何 IO 失败一律吞错（追加失败返回 null，读取失败返回空数组）。
 * 契约：一行一事件 `{id, ts, type, detail, ref}`；损坏行跳过（torn tail 容错）。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryEvent } from './core.ts'

export function historyPath(dataDir: string): string {
  return join(dataDir, 'history.jsonl')
}

/** 读履历：文件缺失/不可读 → 空数组；损坏行跳过（不抛） */
export function readHistory(dataDir: string): HistoryEvent[] {
  const p = historyPath(dataDir)
  const out: HistoryEvent[] = []
  try {
    if (!existsSync(p)) return out
    const lines = readFileSync(p, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as HistoryEvent
        if (typeof ev?.ts === 'string' && typeof ev?.type === 'string') out.push(ev)
      } catch {
        // 损坏行跳过（torn tail 容错）
      }
    }
  } catch {
    // 不可读 → 空
  }
  return out
}

let historyCounter = 0
/** 事件 id：时间基 36 进制 + 进程内自增序号（同毫秒不撞车） */
export function nextHistoryId(nowMs: number): string {
  historyCounter += 1
  return `e-${nowMs.toString(36)}-${historyCounter}`
}

/**
 * 追加一条履历。失败吞错返回 null（调用方据此上报「写入失败」而不炸）。
 * now 注入：原实现分别取 Date.now()（id）与 new Date().toISOString()（ts），
 * 这里统一用同一时刻的 now——同一调用内二者本就同毫秒，行为等价。
 */
export function appendHistory(
  dataDir: string,
  ev: { type: string; detail?: string; ref?: string | null },
  now: Date = new Date(),
): { id: string; ts: string } | null {
  try {
    mkdirSync(dataDir, { recursive: true })
    const full: HistoryEvent = {
      id: nextHistoryId(now.getTime()),
      ts: now.toISOString(),
      type: ev.type,
      detail: ev.detail ?? '',
      ref: ev.ref ?? null,
    }
    appendFileSync(historyPath(dataDir), JSON.stringify(full) + '\n', 'utf-8')
    return { id: full.id, ts: full.ts }
  } catch {
    return null
  }
}
