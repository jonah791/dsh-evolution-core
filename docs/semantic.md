# 语义文档：dsh-evolution-core（进化核心）

| 项 | 值 |
|----|----|
| 能力名 | `dsh-evolution-core`（插件内 `name = 'evolution-core'`；组合行 id `agent-evolution-core`） |
| 主副本路径 | `self-plugins/dsh-evolution-core/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-evolution-core/src/index.ts`（499 行）、`src/core.ts`（纯逻辑）、`src/format.ts`（呈现纯层）、`src/history-store.ts`（履历 IO 薄壳） |
| 版本 | v0.1.0（package.json） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` 第 234–236 行：`- insert:` / `- id: agent-evolution-core` / `name: dsh-evolution-core`（**该行无 config → 全部默认值**） |
| 状态 | **draft**（2026-09-14 补课文档；除标注「已实测」外，验收条目待验收） |
| 依赖服务 | 消费 `inject = ['tools', 'memoryApi']`（index.ts:45）；提供 `evolutionCore` 服务（index.ts:279） |
| 上下游 | 上游：7 个进化器官的 JSON（**只读**）；下游：`dsh-life-core`（`inject` 含 `evolutionCore`，感知圈拉快照） |

---

## 1 · 定位与反定位

**定位**：把分散的进化器官（self-test / emotion / reflection / life-core / evolve / memory / checkpoint）的运行时状态**聚合为一次只读快照**，按「五环完整性」（猜想→采证→finding→裁决→布线）诊断**断点 + 按优先级的行动建议**，并把进展记进自持履历（`history.jsonl`）作积极性正反馈。它是进化主线的**仪表盘与唤醒器**，不是执行器。

**反定位（本文不管什么）**：
- 不管各器官自身的实现与状态（属 `dsh-agent-self-test` / `dsh-agent-emotion` / `dsh-agent-reflection` / `dsh-life-core` / `dsh-agent-evolve` / `dsh-agent-memory` / `dsh-agent-checkpoint`）——本插件**只读不写**
- 不管决策：不自动裁决 finding、不自动发起评测轮、不自动炼化技能（AGENTS.md §2.1 决策归爱丽丝）
- **不是** 调度器/定时器（无 `setInterval`、无自触发）；**也不管** skill-forge——README 的表述含它，源码实际聚合的器官只有 7 个（§8 偏差）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 器官（organ） | 被聚合的 7 个状态源：`selftest`/`emotion`/`reflection`/`lifeCore`/`memory`/`checkpoints`/`evolve`（键名即 `aggregate().organs` 的键） |
| 器官快照 `OrganSnapshot` | `{ ok: boolean, [k]: unknown }`；`ok:false` = **数据源不可读**（缺失/坏 JSON），不是「值为空」。取值用 `num()`：非有限数一律按 `0`（core.ts:59，脏数据保守为红） |
| 五环 | 猜想 `hypothesize` → 采证 `evidence` → finding → 裁决 `verdict` → 布线 `wire`（自指闭环，AGENTS.md §5.7） |
| 环状态 / 断点 | `green`/`yellow`/`red`/`unknown`（渲染 🟢🟡🔴⚪）；环判 `red` 时输出一条 `{ring,state,signal,suggestion}` = 断点 |
| 布线信号（wire proxy） | 技能目录最新 mtime 折算的「距今天数」——**代理量，非真实布线事件**（`readWireSignal` index.ts:202） |
| 履历 / 回流 | `history.jsonl`（一行一事件 `{id,ts,type,detail,ref}`，本插件**唯一自持写入产物**）；`cycle`/`log` 同时调 `memoryApi.remember`（`kind:'episodic'`、`key:'evolve-history-<id>'`）回流主记忆库，失败**静默** |

## 3 · 概念模型

```
DSH_HOME = process.env.DSH_HOME || ~/.dsh（本机 E:\alice\.dsh）——只读源（readJson/index.ts:105；失败 → null → {ok:false}）：
  self-test.json｜emotion-state.json｜reflection-state.json｜life-core/state.json｜storages/agent_memory.json
  checkpoints/（子目录名）｜skills + ~/.agents/skills 最新 mtime｜<DSH_HOME 上级>/.evolve/ledger.json（可 config 覆盖）
      ▼ aggregate(config) index.ts:216 ─ core.ts summarize*（7 纯函数）→ OrganSnapshot
   ├─ diagnoseRings({selftest,lastWireDays}) → {rings,broken}（布线环靠 skills mtime 折算，递归 depth≤2）
   └─ buildSuggestions({selftest,evolve,checkpoints,lastWireDays})   ▼ 四个出口
 ① evolution_status 全量快照（不写盘）   ② evolution_cycle 快照 + appendHistory('cycle') + 回流
 ③ evolution_history 只读 history.jsonl  ④ ctx.evolutionCore.snapshot() → dsh-life-core 感知圈
```

不变量（invariants）：
1. **I1 只读器官**：源码内对器官路径只有 `readFileSync`/`readdirSync`/`statSync`/`existsSync`；写操作只落在 `history.jsonl` 与 `mkdirSync(dataDir)`——`grep` 可判。
2. **I2 读取永不抛**：器官读取走 `readJson`（try/catch → null）与目录包装；`summarize*` 对 `null`/数组/字符串/`NaN` 一律兜底（tests/core.test.mjs 有退化用例）。
3. **I3 写失败不致命**：`appendHistory` 失败返回 `null` → 工具返回 `{ok:false,error}` 而不抛；回流失败静默（index.ts:257）。
4. **I4 决策零自动化**：无定时器、无自动裁决/评测；`enabled=false` 时四工具全部 fail-soft，服务 `snapshot()` 返回 `null`。
5. **I5 不可读 ≠ 红**：前四环统一降 `yellow`（detail=`数据源不可读`）且**不产生断点**，防把「读不到」误报成「进化停摆」。

## 4 · 契约

### 4.1 配置与落盘
| 项 | 形状 / 默认 | 说明 |
|----|------------|------|
| `enabled` | `boolean`，默认 `true` | 关闭后工具 fail-soft，服务返回 `null` |
| `dataDir` | `string?`，默认 `$DSH_HOME/evolution-core` | 履历目录；`history.jsonl` = `<dataDir>/history.jsonl` |
| `evolveLedgerPath` | `string?`，默认 `<DSH_HOME 上级>/.evolve/ledger.json` | ⚠ 默认值在 DSH_HOME **之外**（本机 = `E:\alice\.evolve\ledger.json`） |
| `wireSignalDirs` / `wireFreshDays` | `string[]?` 默认无 / `number` 默认 `7` | 前者追加布线信号目录（不存在则跳过）；后者**半死**：只进 ready 日志（index.ts:498），阈值硬编码 core.ts:280/282（§8） |
| 落盘产物 | `history.jsonl`：一行一事件 `{id,ts,type,detail,ref}`，`id=e-<base36 ms>-<自增>`；追加写 + 损坏行读取跳过（torn tail 容错） | 事件类型 8 值：`cycle`/`verdict`/`forge`/`evolve`/`wire`/`reflect`/`checkpoint`/`note`（`evolution_log` 的 enum 校验） |

### 4.2 状态→裁决表（纯函数，core.ts）
| 输入状态 | 裁决 | 依据 |
|---------|------|------|
| 前四环器官快照 `ok !== true` | 该环 `yellow`（detail=`数据源不可读`），**无断点** | I5；core.ts:230/242/254/264 |
| `active ≥ 2` / `= 1` / `= 0` | 猜想环 green / yellow / red+断点 | core.ts:232-239 |
| `active > 0 且 activeWithEvidence` / `active > 0 无证据` / `active = 0` | 采证环 green / yellow / red+断点 | core.ts:244-251 |
| `finding = 0` / `≥ 1` | finding 环 green / red+断点（积压即红） | core.ts:256-261 |
| `confirmed + refuted ≥ 5` / `1–4` / `0` | 裁决环 green / yellow / red+断点 | core.ts:266-273 |
| 布线 `≤ 7` / `≤ 30` / `null 或 > 30` 天 | 布线环 green / yellow / red+断点 | core.ts:276-287 |
| 建议排序 | 不可读器官 → finding 积压 → evolve 闲置（>14 红 / >7 黄）→ 猜想/采证 → 布线（>7）→ 存档（>3）→ 兜底「五环健康」 | core.ts:302-349 |
| `evolution_history` 的 `days` | `clampDays`：缺省 30，收敛到 `[1, 3650]` | format.ts:44 |
| 呈现层的**空值边界（2026-09-14 自持）** | `renderOrganLine(key, null/undefined)` → `${key}: ⚠不可读`（与 `ok !== true` 同口径，文案与 `aggregateSnapshot` 原兜底串逐字相同）；`hasRedRing(null/undefined/非数组)` → `false`（读不出的环项按非红处理——不谎报红环，真红仍被看见） | format.ts（函数内自持，调用点判空降为纵深防御） |

### 4.3 调用点清单
| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 第 234–236 行（`- insert:` / `- id: agent-evolution-core` / `name: dsh-evolution-core`，无 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:43` `export const name = 'evolution-core'` | 加载声明 |
| 插件本体（inject） | `src/index.ts:45` `export const inject = ['tools', 'memoryApi']` | 激活门：等 `tools` + `memoryApi` |
| 插件本体 | `src/index.ts:240` `apply(ctx, config)`；`:243` `mkdirSync(dataDir)` | 挂载时 |
| 工具注册 ① | `src/index.ts:293` `ctx.tools.register(defineTool({`，`:294` `name: 'evolution_status'` | 挂载时注册 |
| 工具注册 ② | `src/index.ts:344` `ctx.tools.register(defineTool({`，`:345` `name: 'evolution_cycle'` | 挂载时注册 |
| 工具注册 ③ | `src/index.ts:406` `ctx.tools.register(defineTool({`，`:407` `name: 'evolution_log'` | 挂载时注册 |
| 工具注册 ④ | `src/index.ts:438` `ctx.tools.register(defineTool({`，`:439` `name: 'evolution_history'` | 挂载时注册 |
| 服务提供 | `src/index.ts:279` `ctx.provide('evolutionCore', …)` → `snapshot()` | 挂载时 |
| 消费方（服务） | `dsh-life-core/src/index.ts:32` inject 含 `evolutionCore`；`:88` `ctx.evolutionCore` 取用；`activate.ts:80` 注入闭包 | life-core 感知圈到期时 |
| 落盘（履历） | `src/history-store.ts:49` `appendHistory(dataDir,…)` → `historyPath()`；调用点 `index.ts:383`(cycle) / `:430`(log) | 每次 cycle / log |
| 回流（记忆） | `src/index.ts:250` `refluxEvent()` → `ctx.memoryApi.remember()`；调用点 `:384` / `:432` | 每次 cycle / log |
| 器官只读入口 | `src/index.ts:166–199` `readSelftest/readEmotion/readReflection/readLifeCore/readEvolve/readMemory/readCheckpoints`；`:202` `readWireSignal` | 每次 aggregate |
| 测试 | `tests/core.test.mjs`（`node --test`，import `../lib/core.js`，37 个用例；package.json script `test` = `node --test "tests/*.test.mjs"`） | 手动/回归 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件能**读** DSH_HOME 下的器官状态（含记忆库文件顶层键）并**写** `history.jsonl`、**经 `memoryApi` 回流写主记忆库**；它不校验调用者意图，边界靠上层（主人指令 + 授权纪律）。
- 不越界清单：不改器官状态；不自动执行建议；不发通知（无 telegram/webhook）；不起服务；不注入模型可见输入（数据只经工具面呈现）。
- 失败面：**读失败** → `{ok:false,error:'<file> 不可读'}`（环降黄 + 建议置顶「器官数据源不可读」），放行 + 呈现，不静默不抛；**写失败** → `appendHistory` 返回 `null` → 工具报错，`mkdirSync` 失败不致命；**回流失败** → 静默（刻意：履历真实性不依赖记忆库）；**无超时面**（无网络/无子进程）。

## 6 · 与既有机制的关系

- **AGENTS.md §5.7（自我进化闭环）**：本插件是五环完整性的**观测面**（报缺环，如 finding 积压→红），裁判与执行仍归爱丽丝（`selftest_review`/`skill_commit`/编辑 AGENTS.md）。
- **§5.16（仪器可用性）**：它会把「evolve 闲置 N 天」报成建议，而 §5.16 明确「闲置 ≠ 时机未到」——处置必须是**一次最小探测**（`evolve_spawn`），不得据「闲置」直接推迟。
- **§5.11（组合变更必验证）**：改 `src/*.ts` 后必须 `pnpm build` 使 `lib/index.js` mtime 更新，否则 web 仍跑旧构建。
- **`dsh-life-core` / `dsh-agent-memory`**：本插件提供 `evolutionCore`，life-core 感知圈前拉 `snapshot()` 决定唤醒消息是否含「本圈建议推进」——本插件未挂载或 `snapshot()` 返回 `null` 时，life-core 必须容错降级（已有 `evolutionCore?` 可选类型）；`memoryApi` 由 memory 插件 `provide`（其 src/index.ts:127）。

**生效判据（改代码后怎么证明真的生效）**：
1. 构建产物新**且**比进程新：`lib/index.js` mtime ≥ `src/*.ts` 最大 mtime，**且**晚于当前 web 进程启动时刻（进程级判据，§5.11；`hasUnverifiedBuilds()` 同口径）——**2026-09-14 10:31 实测：产物侧满足**（并行实例 10:30:36 重建 `lib/` 共 8 文件，含 `format.js`/`history-store.js`，晚于 src 10:24:55）；**进程侧不满足**（web = PID 7080 `--profile web --no-open`，启动 10:05:47，**早于**产物 10:30:36 ⇒ 新构建尚未被加载，须哨兵/`daemon_restart` 重启后才算生效）。
2. 工具面在场：工具列表里有 `evolution_status`/`evolution_cycle`/`evolution_log`/`evolution_history`（或 `plugin_inspect dsh-evolution-core` = mounted）。
3. 落盘产物可查：`history.jsonl` mtime 前进且末行 `type` 与刚调用动作一致（**实测：61 行 / 23,087 B / 末行 2026-09-14T02:25:08Z `forge`**）。
4. 服务生效：红环时 life-core 的唤醒消息携带「本圈建议推进」（读 life-core 侧唤醒文本）。

**回退**：本插件无独立版本锚点——`git revert <最近一次提交>`（或 `git checkout -- src/`）→ `pnpm build` → `preflight_check`（full：改代码后必须真试运行）→ 哨兵 / `daemon_restart` 重启 web；配置回退用 `plugin_configure dsh-evolution-core` 还原（当前挂载行**无 config**，整体替换会留 `.bak-<时间戳>`）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/grep/日志/文件） | 状态 |
|---|-----------|--------------------------------|------|
| A1 | 工具面恰好 4 个 `evolution_*`，名字与源码一致 | `grep -cE "name: 'evolution_" src/index.ts` = 4（status/cycle/log/history） | **已实测**（补课 grep） |
| A2 | 只读器官且无自动执行分支 | `grep -nE "writeFileSync\|appendFileSync" src/*.ts` 仅命中 `history-store.ts`；`grep -nE "setInterval\|setTimeout"` 无命中 | **已实测**（§8：index.ts:31 为未使用 import） |
| A3 | `lib/` 产物齐、比源码新，且已被运行进程加载 | `lib/index.js` mtime ≥ `src/*.ts` 最大 mtime；且 mtime > web 进程启动时刻（`Get-CimInstance Win32_Process` 查 PID/启动时间） | 待验收（2026-09-14 10:30:36 实测 8 文件齐、晚于 src 10:24:55 ⇒ 产物侧满足；web 进程 10:05:47 早于产物 ⇒ 须重启后复测；并行改造仍在进行） |
| A4 | 五环判定边界正确；脏数据不抛、保守判红；不可读降黄不误报 | `node --test tests/core.test.mjs`——「五环诊断·猜想/采证/finding/裁决/布线环边界」五条 + 「退化：7 个 summarize* 喂 null/undefined/数组/字符串 → 不抛」「退化：selftest 字段脏（active 是字符串）→ 保守为红」「五环诊断：数据源不可读 → 前四环 yellow（不误报红）」 | 待验收（测试已存在，未执行） |
| A5 | 履历写入形状与追加语义 | `tail -1 <DSH_HOME>/evolution-core/history.jsonl` 为合法 JSON 且含 `id/ts/type`；调用 `evolution_log` 后行数 +1 | 待验收（文件与形状**已实测**：61 行 / 首行 `{"id":"e-mtl61b5q-1",…}`） |
| A6 | `evolution_log` 非法 `type` 被拒；`enabled=false` fail-soft | 传 `type:'bogus'` → schema 校验错误（enum 8 值）；置 `false` 重启 → 四工具返回 `{ok:false,error:'evolution-core disabled'}`、服务 `null` | 待验收 |
| A7 | 回流不阻塞主流程 | 摘掉 `dsh-agent-memory` → 插件仍激活且 cycle/log 正常返回（**注**：`inject` 已硬声明，本条需先裁决 §10 U2） | 待验收 |
| A8 | `dsh-life-core` 容错消费 | 停挂本插件 → life-core 感知圈仍工作（`evolutionCore?` 为 `undefined` 分支） | 待验收 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（499 行，IO+工具+服务）、`src/core.ts`（425 行，零 IO 纯逻辑）、`src/format.ts`（51 行，零 IO 呈现）、`src/history-store.ts`（68 行，履历 IO）；同语义副本：无。
- **未实现 / 未验证 / 偏差（不粉饰）**：
  - **设计文档是死引用**：`docs/evolution-core-design.md` 被 `src/index.ts:5`、`src/core.ts:5`、`README.md:11` 引用，但该文件**不存在**（`docs/` 即本次补课新建）——设计依据只能从源码与本文恢复。
  - **构建滞后已消除，但「未生效」与教训保留**：`lib/` 曾仅 `index.js`/`core.js`（均 09-07 14:26），落后源码约三天；并行实例已于 **09-14 10:30:36** 重建（8 文件，含 `format.js`/`history-store.js`，晚于 src 10:24:55）——**但 web 进程启动于 10:05:47，早于产物 mtime ⇒ 线上仍在跑 09-07 旧构建**（旧构建自洽；新源码能力须重启才生效）。教训：mtime 只证明「构建过」，生效判据必须含**进程启动时刻**（§5.11 §6）。
  - **测试只覆盖一半**：`tests/core.test.mjs` 只 import `../lib/core.js`；`format.ts`/`history-store.ts`/`index.ts`（工具面、服务、回流、参数校验）**无测试** ⇒ A5–A8 只能线上取证。
  - **死 import**：`src/index.ts:31` 导入的 `writeFileSync` 与 `appendFileSync` 在 `index.ts` 内**均未使用**（写操作已抽到 `history-store.ts`）；`tsconfig.json` 未开 `noUnusedLocals`，tsc 不报。
  - **`wireFreshDays` 半死**：`Config` 有该字段（默认 7）但只出现在 ready 日志（index.ts:498）；布线环 7/30 天阈值在 `core.ts:280/282` 硬编码——改配置不改判定，与 README 表述不符。
  - **`inject` 与「可选」措辞冲突**：index.ts:44 注释称 `memoryApi` 为「可选回流服务」，index.ts:45 却写进 `inject`（cordis 激活门：服务缺失则本插件不激活）；实现侧访问走 `(ctx as unknown as {memoryApi?})` 软容错（index.ts:252 判 `undefined` 即 return）——声明硬 + 实现软，语义未定（§10 U2）。
  - **README 与源码不一致**：README 称聚合含「skill-forge」，源码 7 个读取器中无 skill-forge（`evolution_status` 的 7 器官表述与源码一致）。
  - **并行改造中（含未核实项）**：`src/format.ts`、`src/history-store.ts`、`tests/`、`package.json` 由**另一并行实例**于 09-14 10:24–10:26 引入/改动且未提交（`git status`：`M src/index.ts` / `M package.json` / `?? src/format.ts` / `?? src/history-store.ts` / `?? tests/`）——本文行号以 `src/*.ts` @ 2026-09-14 10:24 为快照，可能随后续改造漂移；旧构建（09-07 `lib/index.js`）与当前源码的**逐行行为差异面未核实**。

## 9 · 实践修订记录

- **2026-09-14 修复两条已登记缺口（任务 `t-b5bcd8c5`，format.ts 自持边界）**
  - **L2**：`renderOrganLine` 直接读 `o.ok` ⇒ `null`/`undefined` 快照抛 `TypeError`，判空只存在于调用方（`aggregateSnapshot` 的 `organ === undefined ? ... : ...`）——从调用点移除判空即线上崩溃。现函数内自持：`null`/`undefined` 与 `ok !== true` 同口径返回 `${key}: ⚠不可读`（**文案与调用点原兜底串逐字相同 ⇒ 行为不变，只是护栏下移**）。
  - **L3**：`hasRedRing([null])` 抛 `TypeError`（环数组此前恒由 `diagnoseRings` 产出 = 隐式前提）。现非数组 → `false`，沿用本文件既有口径「读不出的环项按非红处理（保守）」；与 `{state}` 缺失项同判据，且不因脏项漏报真红。
  - 测试 61/61 全绿；两条哨兵由 `assert.throws` 翻为行为断言（`format.test.mjs`）。
  - 语义**被确认**：四工具面（status/cycle/log/history）、三原则（只读器官 / 不自动执行 / 仅经工具面呈现）、五环判定表、`history.jsonl` 契约、`evolutionCore` 服务被 `dsh-life-core` 消费。
  - 语义**被补充**：器官路径与默认值（含 `evolveLedgerPath` 落在 **DSH_HOME 之外**）；布线环用**技能目录 mtime 代理**而非真实事件；回流的字段（`kind:'episodic'`、`key:'evolve-history-<id>'`）与**静默失败**；不可读降 `yellow` 而非 `red`。
  - 语义**被修正**：无（首次成文）；但登记四处文档/声明与实现的偏差（设计文档死引用、构建滞后、`wireFreshDays` 半死、`inject` 与「可选」冲突）——见 §8。
  - 教训：① 注释里写「设计文档：docs/x.md」而文件从未存在 ⇒ **引用不是证据**，语义文档必须指向真实落点；② 只读型插件最容易漏写「它到底写了什么」（本插件写入面 = `history.jsonl` + 记忆回流，此前只散在源码）；③ 补课时**先核对产物 mtime 与进程启动时刻**（mtime 变新只证明「构建过」，进程更早启动 = 未生效——本稿初版即因只读 mtime 而把状态写反，10:31 复核后订正）。

## 10 · 未决问题

- **U1 死引用清理**：`docs/evolution-core-design.md` 被 3 处引用却不存在——补写设计文档，还是把引用改指本文？倾向**改指本文**（避免两份平行语义，I1）。
- **U2 `memoryApi` 硬依赖还是软依赖**：`inject` 声明为硬（激活门），实现为软（判 `undefined` 跳过回流）。软则改 `ctx.get('memoryApi')` 且移出 `inject`；硬则删注释与容错分支。需裁决并一次性收敛（涉及与 `dsh-agent-memory` 的挂载顺序）。
- **U3 `wireFreshDays` 归属**：参数化 `core.ts` 的 7/30 阈值（环判定接受入参 + 补单测），还是从 `Config` 移除？现状「配置存在但不生效」是最差路径。
- **U4 重建已做、重启未做的收口**：`lib/` 已重建（09-14 10:30:36，8 文件）但 web 进程（10:05:47 启动）尚未加载 ⇒ 何时重启生效，是否由正在改造的**该实例**收口时统一走哨兵（§5.11 进程级判据 + §5.14 不重复劳动）？
- **U5 布线环代理量可靠性**：`skills` 目录 mtime 会把「任何技能文件触碰」都算成布线——是否改为「履历 `evolution_log(type:'wire')` 优先、mtime 兜底」的双判据？
