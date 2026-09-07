# dsh-evolution-core

进化核心插件（心脏）：把分散、被动、无内驱力的进化器官（self-test / skill-forge / emotion / reflection / life-core / evolve / memory / checkpoint）聚合为**可观测、可诊断、可驱动**的运行时——补上「五环完整性」（猜想→采证→finding→裁决→布线）的缺环，让进化从被动响应变主动推进。

设计文档：`docs/evolution-core-design.md`

## 三原则

1. **只读取证**：读各器官 JSON 永不写它们（各器官自管状态）
2. **不自动执行**：只输出「状态 + 断点 + 建议清单」，执行哪个由爱丽丝裁决（自主性铁律：不代决，只唤醒+建议）
3. **Model-visible ⟺ logged**：数据经工具面呈现，不注入模型可见输入

## 工具面

| 工具 | 作用 |
|------|------|
| `evolution_status` | 状态总览：7 器官快照 + 五环诊断 + 断点 + 行动建议（只读） |
| `evolution_cycle` | 感知圈驱动版：聚合 + 诊断 + 本圈推进清单 + 记 cycle 足迹 |
| `evolution_log` | 留痕：把进化动作（verdict/forge/evolve/wire/reflect/checkpoint/cycle/note）记入履历 |
| `evolution_history` | 履历/积极性反馈：时间线 + 统计（累计/连续活跃天数/分布）+ 鼓舞总结 |

## 数据文件

- `$DSH_HOME/evolution-core/history.jsonl`：进化履历事件流（每行一个 JSON 事件）

## 数据路径（只读取证）

| 器官 | 路径 |
|------|------|
| self-test | `$DSH_HOME/agent-self-test/self-test.json` |
| emotion | `$DSH_HOME/agent-emotion/emotion-state.json` |
| reflection | `$DSH_HOME/agent-reflection/reflection-state.json` |
| life-core | `$DSH_HOME/life-core/state.json` |
| memory | `$DSH_HOME/storages/agent_memory.json`（只读顶层键） |
| checkpoints | `$DSH_HOME/checkpoints/`（目录列表） |
| evolve | `<DSH_HOME 上一级>/.evolve/ledger.json`（⚠ DSH_HOME 外，config 可覆盖） |

## 配置

```ts
interface Config {
  enabled: boolean            // 默认 true
  dataDir?: string            // 核心数据目录，默认 $DSH_HOME/evolution-core
  evolveLedgerPath?: string   // evolve ledger 路径覆盖
  wireSignalDirs?: string[]   // 额外布线信号目录（技能等）
  wireFreshDays: number       // 布线 green 阈值（默认 7 天）
}
```
