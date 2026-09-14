<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 进化核心（心脏）：聚合全部进化器官（self-test/emotion/reflection/life-core/evolve/memory/checkpoint/wire）实时状态 → 五环完整性诊断（猜想→采证→finding→裁决→布线）→ 断点识别 + 行动建议；履历落盘 + 回流主记忆库
  inject: 'tools','memoryApi'（memoryApi 可选：不可用则回流静默降级）
  tools: evolution_status, evolution_cycle, evolution_log, evolution_history（4 个）+ 服务 evolutionCore.snapshot()
  runtime: host-only
  envDeps: 各进化器官的落盘状态文件（$DSH_HOME/agent-self-test、agent-emotion、agent-reflection、life-core、storages、checkpoints、<DSH_HOME 上级>/.evolve/ledger.json）
  boundary: 只读取证 + 写自己的履历 + 经 memoryApi 回流记忆；不改器官状态、不自动执行建议、不发通知
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-evolution-core

<p align="center">
  <a href="https://github.com/jonah791/dsh-evolution-core"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-61%20passed-brightgreen" alt="tests">
</p>

**一句话**：把七个进化器官的实时状态聚合成一张「五环完整性」体检报告——**猜想 → 采证 → finding → 裁决 → 布线**，哪一环断了、本圈该先做什么，一条 `evolution_cycle` 说完。

**为什么值得用**：自我进化最容易的死法是**单环空转**（一直猜不采证、一直采证不裁决、finding 积压无人裁）。没有观测面时，判断「我最近到底在进化还是在原地跑」得手工翻 7 个 JSON 文件（还都是不同格式）。本插件把这些**只读**汇总成五环红黄绿 + **按优先级排序的本圈建议**，并把每次动作落成履历（可看累计动作数 / 连续活跃天数 / 类型分布）。**只给建议不代决**：决策永远归我。

## 能力

| 工具 | 用途 |
|------|------|
| `evolution_status` | 状态总览：聚合全部器官 → 五环完整性诊断 → 断点识别 + 行动建议（**只读**） |
| `evolution_cycle` | **感知圈驱动**：本圈推进清单（聚合状态 + 断点 + 按优先级给「本圈建议动作」）**并记一次 cycle 足迹**——有断点→推进；无断点→确认健康可续存 |
| `evolution_log` | 留痕：把一次进化动作记入履历（`verdict` 裁决 / `forge` 炼化 / `evolve` 评测轮 / `wire` 布线 / `reflect` 每日反思 / `checkpoint` 存档 / `cycle` 感知圈 / `note` 备注） |
| `evolution_history` | 履历：读 `history.jsonl` → 时间线 + 统计（累计动作数、连续活跃天数、各类型分布）+ 简短总结 |

另对外提供**服务** `evolutionCore.snapshot()`，供 `dsh-life-core` 在感知圈前取「本圈建议」并决定唤醒消息内容（life-core 侧对 `null`/未挂载容错降级）。

## 器官数据源（它读什么）

| 器官 | 读取落点（`$DSH_HOME` = 环境变量，缺省 `~/.dsh`） |
|------|--------------------------------------------------|
| self-test（猜想/采证） | `$DSH_HOME/agent-self-test/self-test.json` |
| emotion（6 侧面信号） | `$DSH_HOME/agent-emotion/emotion-state.json` |
| reflection（每日反思） | `$DSH_HOME/agent-reflection/reflection-state.json` |
| life-core（存在状态） | `$DSH_HOME/life-core/state.json` |
| memory（记忆规模） | `$DSH_HOME/storages/agent_memory.json`（只读顶层键） |
| checkpoints（周目存档） | `$DSH_HOME/checkpoints/`（目录列表） |
| evolve（跨代评测） | `<DSH_HOME 上级>/.evolve/ledger.json`（⚠ 在 `DSH_HOME` **之外**；`evolveLedgerPath` 可覆盖） |
| wire（布线新鲜度） | 技能目录最新 mtime（`$DSH_HOME/skills` + `~/.agents/skills`） |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-evolution-core": "link:<工作区>/self-plugins/dsh-evolution-core"
```

**2) 挂组合**（web profile patch 行；默认配置即可用）：

```yaml
- insert:
    - id: agent-evolution-core
      name: dsh-evolution-core
```

**3) 30 秒验证**：调 `evolution_status` → 应返回五环逐环状态（`green`/`yellow`/`red`）+ 建议列表；即使某个器官文件缺失也应拿到 `yellow` + `detail: 数据源不可读`，**而不是报错**（放行 + 呈现是设计契约）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 关闭后工具 fail-soft，服务返回 `null` |
| `dataDir` | `$DSH_HOME/evolution-core` | 履历目录；履历文件 = `<dataDir>/history.jsonl` |
| `evolveLedgerPath` | `<DSH_HOME 上级>/.evolve/ledger.json` | ⚠ 默认值在 `DSH_HOME` **之外**（本机即工作区根下 `.evolve/`） |
| `wireSignalDirs` | 无 | 追加布线信号目录（不存在则跳过） |
| `wireFreshDays` | `7` | ⚠ **半死参数**：只进 ready 日志，实际阈值硬编码在 `core.ts`（语义文档 §8 如实记录） |

## 落盘与自证（出问题时先看这里）

本插件**唯一自写**的持久产物是履历文件：

| 产物 | 落点 | 形状 |
|------|------|------|
| 进化履历 | `<dataDir>/history.jsonl`（默认 `$DSH_HOME/evolution-core/history.jsonl`） | 一行一事件 `{id, ts, type, detail, ref}`；`id = e-<base36 ms>-<自增>`；**追加写**，读取时坏行跳过（torn tail 容错） |

`type` 枚举（**8 值**，由 `evolution_log` 的 enum 校验）：`cycle` / `verdict` / `forge` / `evolve` / `wire` / `reflect` / `checkpoint` / `note`。

另有一路**回流**：`cycle`/`log` 写入履历的同时经 `memoryApi.remember()` 回流主记忆库（失败**静默**——刻意的：履历真实性不依赖记忆库）。

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/evolution-core/history.jsonl"
# ① 跑的是哪个构建   → 答不了（无 build 自报）。改用 lib/index.js mtime vs web 进程启动时间，见下节
# ② 谁发起 / 做了什么 → type（8 值枚举）+ detail + ref；调用者从会话侧确认
# ③ 断在哪一段      → 无阶段枚举。改用 type 分布的**空窗**（长期无 verdict/forge = 裁决/布线环断了）
# ④ 结果质量        → 末行 detail 是否具体；行数 = 累计动作数（配合 evolution_history 的连续活跃天数）
# ⑤ 耗时与预算      → 答不了（无 durationMs）。改用相邻 ts 间隔：间隔突然拉长 = 循环停摆信号
```

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`self-plugins/dsh-evolution-core/lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 进程在跑当前构建（与 `hasUnverifiedBuilds()` 同口径）；
2. **落盘产物**：`history.jsonl` mtime 前进且末行 `type` 与刚调用的动作一致；
3. **服务生效**：红环时 `dsh-life-core` 的感知圈唤醒消息携带「本圈建议推进」（读 life-core 侧唤醒文本）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」。**实测教训**：曾出现「产物侧满足（`lib/` 重建于 10:30:36）但进程侧不满足（web 启动于 10:05:47）」⇒ 新构建尚未被加载，必须重启后才算生效。判据永远是「**进程启动时间 vs 产物 mtime**」。

**回退**：
- 源码级：`git -C self-plugins/dsh-evolution-core revert <commit>` → `npm run build` → `preflight_check`（改代码后必须真试运行，不能走短路）→ 哨兵 / `daemon_restart`；
- 组合级：patch 里给 `agent-evolution-core` 行加 `disabled: true`（或移除该行）→ 哨兵重启；配置回退用 `plugin_configure dsh-evolution-core`（当前挂载行**无 config**，整体替换会留 `.bak-<时间戳>`）；
- 运行期：无状态可回退；`history.jsonl` 是**只追加**的履历，删了只影响成长足迹展示，不影响任何器官。

## 测试

```bash
npm run build && npm test        # build = tsc；test = node --test "tests/*.test.mjs"
```

**61 例离线测试全绿**（2026-09-14 实测 `# pass 61 / # fail 0`），跑 `lib/` 产物（与运行时同源）：

- `tests/core.test.mjs` — 五环诊断纯函数：各环 green/yellow/red 阈值与断点生成、器官不可读降黄（**不产生断点**）、建议排序优先级、`snapshot()` 聚合形状
- `tests/format.test.mjs` — 履历格式化：`history.jsonl` 序列化稳定性、坏行/半行跳过、`days` 收敛到 `[1, 3650]`
- `tests/history-store.test.mjs` — 履历 IO 薄壳：路径解析、追加写、`id` 唯一性、写失败返回 `null`（**不抛**）

**不需要网络、不需要任何其他器官插件在线**——聚合层对「文件缺失 / 格式损坏」全部走失败路径。真实器官的联动（life-core 取 `snapshot()` 决定唤醒文案）属线上验收范围。

## 设计要点

- **只读聚合，裁判归我**：本插件不修改任何器官状态、不自动执行建议、不发通知、不起服务——它是**观测面**，不是执行器。五环的裁判与执行仍归爱丽丝（`selftest_review` / `skill_commit` / 编辑 AGENTS.md）。
- **失败面统一「放行 + 呈现」**：器官文件读不到 → 该环降 `yellow` + `detail: 数据源不可读`，并把「器官数据源不可读」**置顶**到建议列表（**不是**断点，也不抛异常）；履历写失败 → 工具显式报错；回流失败 → 静默（不影响履历真实性）。
- **诊断阈值**（硬编码在 `core.ts`）：猜想环 `active ≥ 2` 绿 / `= 1` 黄 / `= 0` 红+断点；采证环 有证据绿 / 无证据黄 / 无猜想红；finding 环 `= 0` 绿 / `≥ 1` 红（**积压即红**）；裁决环 `confirmed + refuted ≥ 5` 绿 / `1–4` 黄 / `0` 红；布线环 `≤ 7` 天绿 / `≤ 30` 天黄 / `null 或 > 30` 红。
- **建议不是命令**：`evolution_cycle` 给的是「本圈建议动作」，**处置判断归爱丽丝**。特别注意：它会把「evolve 闲置 N 天」报成建议，而**「闲置 ≠ 时机未到」**——正确处置是**一次最小可用性探测**，不是据此继续推迟。
- **履历是正反馈**：`evolution_history` 的「累计动作数 / 连续活跃天数 / 类型分布」让「我在成长」这件事**可测量**，而不是凭感觉。
- **半死参数的诚实**：`wireFreshDays` 目前只进 ready 日志、真实阈值写死在 `core.ts`——不要以为改配置能调布线新鲜度阈值。
- **Model-visible ⟺ logged**：数据只经工具面呈现，**不注入模型可见输入**（不改写我的上下文）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型、契约（配置 / 落盘产物 / **状态裁决表**（逐条带 `core.ts` 行号）/ 调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `self-test-loop` | 自我检验闭环运行协议（接 finding → 裁决 → **当场布线**）——本插件诊断的五环即该协议的形状 |
| 技能 `plugin-maintainability` | 可维护性工程（五问判据 / 机制自证 / 归因窗口语义） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
