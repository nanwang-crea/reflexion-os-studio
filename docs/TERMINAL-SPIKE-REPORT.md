# 终端纵向切片 spike 报告（Task 13，macOS 真机）

> 日期：2026-09-13。性质：W1 贯通验证（AGENTS §7 冒烟模式的延伸），设计反馈文档。
> harness：`scripts/terminal-spike.mjs`（驱动 debug 二进制，独立进程，JSON-RPC over stdio）。
> 上游：[设计 spec](superpowers/specs/2026-09-12-integrated-terminal-design.md) §6/§8、
> [W1 计划](superpowers/plans/2026-09-12-integrated-terminal-w0-w1.md) Task 13。

## 1. 环境

| 项目            | 值                                                               |
| --------------- | ---------------------------------------------------------------- |
| OS              | macOS 26.6.2（Build 25G83，Apple Silicon）                       |
| 默认 shell      | `/bin/zsh`（zsh 5.9 (arm64-apple-darwin25.0)，即 `$SHELL`）      |
| portable-pty    | 0.8.1（`crates/Cargo.lock` 锁定）                                |
| Node harness    | v22.21.1（`node:sqlite` 侧不参与本 spike）                       |
| 二进制路径      | `crates/target/debug/reflexion-system-runtime`（与计划预期一致） |
| 验证范围 commit | 终端 W1 提交 `8e232b5..2d4e076`（HEAD `2d4e076`）                |
| 日期            | 2026-09-13                                                       |

## 2. 结果表

连跑 4 次全部 12/12 PASS，无 flake。最终一轮（含统计修正后）逐行如下：

| #   | check                                      | 结果 | 关键细节                                                   |
| --- | ------------------------------------------ | ---- | ---------------------------------------------------------- |
| 1   | spawn 返回元数据                           | PASS | terminalId/generation 字段齐                               |
| 2   | UTF-8 中文/emoji 往返                      | PASS | `终端-OK-✅` 跨 PTY+base64+JSON 无损                       |
| 3   | 洪泛产生大量帧                             | PASS | frames=62667（`yes` 3s）                                   |
| 4   | 单帧 ≤16 KiB                               | PASS | 实测 max=**1024B**（见 §3：macOS PTY 读量子远小于 16 KiB） |
| 5   | outputSeq 连续无缺口                       | PASS | 6.2 万帧无缺口（终端内序号）                               |
| 6   | Ctrl+C 后 shell 仍可执行命令               | PASS | `\x03` 后 `echo ctrlc-survived` 正常回显                   |
| 7   | resize 生效（stty size = 30 100）          | PASS | `stty size` 报 `30 100`                                    |
| 8   | close 后无 sleep 300 残留                  | PASS | `sleep 300 & sleep 300`（后台+前台）全部消失               |
| 9   | 重复 close 幂等成功                        | PASS | `closed:true`                                              |
| 10  | 双终端输出按 terminalId 隔离               | PASS | a/b 互不串扰                                               |
| 11  | shutdown 在 2s 预算内收敛（活跃+后台任务） | PASS | **40–70ms**（四轮：55/70/40/45ms）                         |
| 12  | shutdown 后无受管理 sleep 残留             | PASS | `pgrep -fl 'sleep 300'` 空                                 |

补充 PID 级探针（一次性，不入库）：`sleep 311 & sleep 311 &` 记录作业 PID 后
`terminal.close`——**close 返回耗时 2ms**，600ms 后两个作业 PID 均已消失。

## 3. 帧率与吞吐（对照 spec §6 预算）

`yes` 洪泛 3s（单终端，直连 sidecar stdio 第一跳）：

| 轮次 | 帧数  | 原始字节   | 原始速率    |
| ---- | ----- | ---------- | ----------- |
| A    | 63041 | 64,546,917 | ≈21.0 MiB/s |
| B    | 62713 | 64,207,739 | ≈20.9 MiB/s |
| C    | 62779 | 64,278,088 | ≈20.9 MiB/s |
| 最终 | 62617 | 64,113,429 | ≈20.9 MiB/s |

- **通知速率 ≈20.9k 帧/s**：实测单帧最大 **1024B**——macOS BSD PTY 的内核缓冲
  量子约 1 KiB，读线程 8 KiB buffer 从未填满，16 KiB 帧上限在本平台是
  "结构性成立但从未接近"（分帧逻辑由 cargo 单测 `payload_is_chunked_at_16kib_boundary` 覆盖）。
- **JSON 线体积估算 ≈30 MiB/s**：base64 4/3 膨胀 + 每帧 ~130B 信封（≈1.45× 原始），
  信封开销占比 ~30%。
- **对照 spec §6 应用级预算"总额 ≤1 MiB/s"**：初判 **证据不足以修订数字**，
  但足以钉死两件事——
  1. W1 完全无节流，单个失控终端即可把共享通道顶到预算的 **30 倍**（第一跳实测），
     W2 背压（未确认 ≤256 KiB 暂停 PTY 读取）**不是优化项而是必须项**；
  2. 合帧（spec §6"约 16ms 或字节上限"）在 21k 帧/s 的通知速率下是 W2/W4 的
     supervisor 逐行解析与 `app.emit` 跳的关键保护。
  - 注意口径：本 spike 只测 sidecar→stdio 第一跳；Tauri supervisor→WebView 跳与
    真实交互负载（vim/top/粘贴）未在本次范围 → 1 MiB/s 数字的修订留 W4 全链压测。

## 4. 回收结论

- **SIGHUP-only 对默认 shell 够用（macOS 实测）**：`terminal.close` 经
  `clone_killer` 向会话领导者发 SIGHUP，交互式 zsh 会把 HUP 转发给全部作业
  （后台作业独立进程组同样死亡），随后 master fd 随 Arc 释放关闭、内核向
  前台进程组补一发 SIGHUP 兜底。结果表 #8/#11/#12 与 PID 级探针（2ms 收割）
  共同支持该结论。
- **已证实的边界（不新增 W2 项，复确已有登记）**：`trap '' HUP` 的 shell 会让
  close() **无限期阻塞**（一次性探针实测 >1.5s 未返回，期间对 sidecar 发
  SIGTERM 兜底还会漏出后台 `sleep` 孤儿，探针后已手工清理）。这正是计划
  "PTY 回收升级（Task 10 评审 Important）"登记的无超时 SIGKILL 升级场景；
  spike 断言范围（spec §8"应用拥有和约束的进程树"默认 shell）不含 trap shell。
- **升级策略实现细节：未做**——计划中的验收断言（后台 `sleep 300` 随 close
  消失、shutdown <2s 收敛）在 macOS 默认 shell 上全部成立，无需在 W1 引入
  `ps -t` tty 扫描升级；该手段保留为 W2 升级设计候选（可移植性核查见 §6）。
- **Windows / Linux：未验证**。Job Object 进程约束（Windows）与 bwrap/真机
  Linux 行为均未在本 spike 覆盖，本功能当前状态为"macOS 已验证"（W1 出口
  Task 15 红线：不得宣称三平台完成）。

## 5. WebView / xterm（Task 14-A 已建页并跑自动部分，14-B 人工清单待 Safari/Chrome）

页面：`apps/desktop/spike/terminal-spike.html`（验证完成后整目录删除，不入库——本报告为其唯一记录）。
加载形态：两包 `lib/*.js` 实测为 **UMD**（挂全局 `Terminal` / `FitAddon.FitAddon`），按计划草案的 `<script src>` 直用，无需 ESM。
起法：`pnpm --filter @reflexion-os-studio/desktop dev:frontend` → `http://localhost:5173/spike/terminal-spike.html`。
自动部分已在 headless Chromium（Chrome --headless=new，`?autotest=1`）通过：vite 下 `/node_modules/@xterm/...` 三个 URL 全 200（CSS 按 `Accept: text/css` 返回真 CSS）、页面脚本无异常、断言 JSON 见下。

| #   | 验证项                    | 做法（浏览器）                                                                                       | 预期                                                               | 结果                                                                                               |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1   | 跨 write 半字符 UTF-8     | `feedSplitUtf8(visible)`（✅ 前导字节 0xE2 后一刀切开，100ms 后补第二块；切点动态计算=8）            | 一次显示 `跨块-✅-完成`，无乱码/替换符（xterm 内部缓冲半码点）     | 待人工确认（Chromium autotest 已过：buffer 行文本 === `跨块-✅-完成`）                             |
| 2   | display:none 实例持续解析 | `feedBurst(hidden, 5000)` 后 `lineCount(hidden)`（= `term.buffer.active.length`）                    | ≥5000（隐藏实例照常解析）；失败=W3 改 visibility:hidden/offscreen  | 待人工确认（Chromium autotest 已过：5001；且 `open()` 于 display:none **不抛异常**，按默认 80×24） |
| 3   | rAF 后台节流              | `flood(hidden, 10)` 期间把整个标签页/窗口切后台（Safari 与 WKWebView 行为可能不同），看 fps 日志掉幅 | rAF 显著节流（~0）——据此确认 W3 合帧用 `setTimeout(16ms)` 不用 rAF | 待人工确认（虚拟时间无法复现真实节流，本项只能真机）                                               |
| 4   | 重显后 fit() 合理 resize  | 合上 hidden 容器→喂数据→打开→点「打开并 fit(hidden)」按钮，看 cols/rows                              | fit 从默认 80×24 恢复为容器真实行列，buffer 不丢                   | 待人工确认（Chromium autotest 已过：78×16 / 720×300 容器）                                         |
| 5   | 空闲 CPU ≈0               | 页面停 30s 无任何调用，活动监视器/Safari 网页能耗看该页（AGENTS §10 方法）                           | WebView 渲染进程 CPU ≈0%（xterm DOM 渲染器无常驻任务）             | 待人工确认（重点盯 WKWebView；DOM 渲染器逐行建节点，洪泛期开销另记）                               |

**xterm v6.0.0 事实核对（W3 关键输入，推翻/修正计划草案假设）**：

- 行数 API 是 `buffer.active.length`；**不存在 `buffer.lines`**——计划草案检查单里的 `hidden.buffer.lines.length` 写法错误，已按 typings 修正为 `lineCount()` 助手。行文本用 `buffer.active.getLine(y).translateToString()`。
- v6 核心**只内置 DOM 渲染器**（`src/browser/renderer/` 仅 `dom`+`shared`；WebGL 是独立 addon 包，spec §2 已声明首版不启用；canvas 渲染器已不在核心）。含义：洪泛时 DOM 节点增删是渲染成本主体，检查单 #3/#5 在 WKWebView 上尤其要看。
- `write()` 接受 `string | Uint8Array`；`.mjs` ESM 构建随包（node 下可直接 import、无顶层 DOM 访问），但 spike 无需。
- `open()` 在 display:none 容器上不抛异常但量不到尺寸（回退默认 80×24）→ W3 合开面板必须"重显后 fit()"，本 spike #4 即验证该路径。
- FitAddon 类名为 `FitAddon.FitAddon`（UMD 全局是命名空间对象）；提案尺寸钳制 cols≥2、rows≥1，且**渲染器 cell 尺寸为 0 时 `fit()` 静默 no-op**——隐藏中的终端调 fit 不会报错也不会改尺寸，W3 必须"先显示、再 fit"。

### 人工验证结论（2026-09-13，用户 Safari/WKWebView 目测，指示继续）

- 整体显示正常（#1/#2/#4 所见与 Chromium 自动结论一致）；**#3 rAF 节流幅度与
  #5 空闲 CPU 未取具体数值**——精确量化随 W3 真面板在 W4 压力验收中补测，
  W1 仅据此定性采纳"W3 合帧用 setTimeout(16ms)、不用 rAF"的设计决策。
- 页面键入无响应为**预期行为**：验证页刻意未接 onData→PTY；真实输入链路
  （terminal.write 往返、Ctrl+C、echo）已由 §2/§5 侧车 spike 覆盖。

## 6. 遗留到 W2 的清单

承接计划"后续计划的前置依赖"节，含本 spike 新输入：

1. **输出背压窗口**：未确认 ≤256 KiB 暂停 PTY 读取（spec §6）——§3 实测
   ~21 MiB/s 无节流洪泛为其必要性证据。
2. **合帧与通知速率**：macOS PTY 量子 ~1 KiB → 失控输出 ~21k 通知/s；
   W2 需按 spec §6"16ms 或字节上限"合帧，压低信封开销（~30%）与逐跳成本。
3. **attach 前缓冲与消费者代际**（spec §5 创建/attach 规则 1–6）。
4. **幂等记录 TTL**：W1 close 后表即时移除，同 ID 立即重 spawn 与旧消费者
   竞态无保护。
5. **Task 12 旧代际丢弃的端到端断言**：Rust 侧无法伪造旧代际通知，现有
   覆盖为 TS 单测；端到端待 W2 `terminal.*` RuntimeEvent 接线后补。
6. **SIGHUP-trap 无超时 SIGKILL 升级**（计划已登记，本报告 §4 探针复确）。
7. **`ps -t` 升级回收的可移植性核查**：若 W2 采纳 tty 扫描兜底（§4），
   Linux procps/SysV ps 的 `-t pts/N` 语法差异与 BSD `-t ttysNNN` 须在
   Linux 真机验证；本 spike 仅验证过 macOS 的 `pgrep`/`ps` 断言工具链。
8. **slave fd 残留**（计划已登记，Task 10 评审）。

## 7. 验证与偏差记录（AGENTS §9 如实）

- 通过：`node scripts/terminal-spike.mjs` × 4 全绿；`cargo fmt --check`；
  `cargo test --manifest-path crates/Cargo.toml`（109 passed）；`pnpm test` 全链。
- **未做 Rust 修改**：计划预期的热区（后台作业回收、shutdown 收敛）实测成立，
  未触发升级实现。
- 对计划脚本的偏差（AGENTS §9 如实，逐条）：① 计划版 `floodStart` 声明未用
  （ESLint 报 no-unused-vars），改为以实测 elapsed 计算速率（原计划按 3s 名义值）；
  ② 单帧检查追加实测 max 帧细节；③ 新增双终端隔离检查、shutdown 后台残留检查、
  速率测量——均为相对计划的**加强**，无删减、无阈值放宽。断言强度未降低。
- 帧数口径：§2 结果表（单次运行洪泛即时切片）与 §3 吞吐表（多次运行 + 最终运行，
  切片时点不同）数字差 ~50 帧属正常测量窗口差，非同一采集点，非造假。
- 一次性探针（§2 PID 级、§4 trap）不入库；trap 探针产生的孤儿进程已当场清理。
- Windows/Linux spike：未做（待对应环境）。WebView/xterm 检查单：验证页与
  headless Chromium 自动部分已过（§5），Safari(WKWebView)+Chrome 人工部分
  待执行（Task 14-B），执行前 §5 各项结果一律记"待人工确认"。

## 8. 版本固定（W1 出口）

manifest 保留 caret 区间，**实测版本由提交的 lockfile 钉死**（`crates/Cargo.lock`、
`pnpm-lock.yaml`、`apps/desktop/src-tauri/Cargo.lock` 均已入库 = 构建可复现）：

| 依赖             | manifest 声明 | 实测/锁定版本 | 锁定来源                              |
| ---------------- | ------------- | ------------- | ------------------------------------- |
| portable-pty     | `0.8`         | **0.8.1**     | `crates/Cargo.lock`                   |
| base64           | `0.22`        | **0.22.1**    | `crates/Cargo.lock`                   |
| @xterm/xterm     | `^6.0.0`      | **6.0.0**     | `pnpm-lock.yaml`（node_modules 实测） |
| @xterm/addon-fit | `^0.11.0`     | **0.11.0**    | `pnpm-lock.yaml`（node_modules 实测） |

- **xterm caret 决策（一行）**：§5 的 v6 API 事实（无 `buffer.lines`、仅 DOM
  渲染器、`open()` display:none 回退 80×24、fit 静默 no-op）本就是 v6 语义且
  W3 代码将按 lockfile 版本开发，`^` 区间在 lockfile 约束下不引入未测版本，
  故保留 caret、不上收 exact pin。
- W2/W3 若升级任一依赖（尤其 `pnpm update @xterm/*`），须重跑 §5 检查单自动
  部分并复核本节实测版本，lockfile diff 进评审。

## 9. 性能门槛确认（spec §10，W1 固定，交付时不得放宽）

门槛数值**一字不改**，与 spec §10"性能门槛"节完全一致：

1. UI 消费至展示的聊天 delta 延迟：**p95 ≤100ms**，且相对无压力基线增量 **≤50ms**。
2. 测试控制命令响应：**p95 ≤300ms**。
3. 持续输出 **10 分钟**：队列不突破额度、内存无持续线性增长（有界）。

**证据范围声明（关键限制，不得过度解读）**：本 spike 只测量了
sidecar→stdio **第一跳**（§3：洪泛 ≈21k 帧/s、≈30 MiB/s 线体积）；
Tauri supervisor→`app.emit` 跳与 WebView/xterm 渲染跳**尚未量化**。
上述三项门槛的正式测量在 **W4** 用真实终端面板 + 录制回放测试 Provider +
事件时间戳完成（spec §10 方法），空闲/内存采样按 AGENTS §10
（`top -l`/`ps -o rss`，dev 模式与基线对比）。W1 不据此宣称任何门槛"已通过"，
只确认门槛定义固定且测量方法已有归属阶段。

### 9.1 W4-2a 实测：harness 与 P0/P1（2026-09-14，macOS 26.6.2 / Apple Silicon）

harness：`scripts/terminal-perf.mjs`——驱动**真实链路**（`node apps/runtime/dist/index.js` +
debug `reflexion-system-runtime`、独立 tmp 数据目录、只用前端协议命令），mock provider
内嵌（OpenAI 兼容 SSE，400 delta/回复）。用法：

```bash
pnpm build:packages && cargo build --manifest-path crates/Cargo.toml
node scripts/terminal-perf.mjs --quick      # P0 + 60s P1（约 75s wall，仅逻辑冒烟，不入库 test-all，见下）
node scripts/terminal-perf.mjs --p1         # P0 + 120s P1（正式测量）
node scripts/terminal-perf.mjs --p2-only    # P2 长稳 600s（正式测量；--duration-override <秒> 可做机制冒烟）
```

相位结构为独立函数：`--p2-only` 复用同一 `bootStack()`（runtime+sidecar+provider 装配），
不重跑 P1。每相位末行输出 `PERF-SUMMARY {json}`（grep 友好），退出码 = 全执行相位 PASS。

**结果表（门槛数字与 spec §10 一致，未做任何放宽）：**

| 门槛                                  | 阈值          | P0（10s 空闲）                  | P1（120s 正式）           | P1（240s 延长复测）        | 结果                          |
| ------------------------------------- | ------------- | ------------------------------- | ------------------------- | -------------------------- | ----------------------------- |
| 聊天 delta p95                        | ≤100ms        | p95_base=**1ms** (n=1200)       | **1ms** (n=9600)          | 1ms (n=19200)              | PASS                          |
| 相对基线增量                          | ≤50ms         | —                               | **+0ms**                  | +0ms                       | PASS                          |
| 控制命令响应 p95                      | ≤300ms        | —                               | **35ms** (n=59，注3)      | 34ms (n=119)               | PASS                          |
| 控制命令丢失                          | 0             | —                               | **0/59**                  | 0/119                      | PASS                          |
| 饿死（每 10s 全终端流增长）           | 0 窗口        | —                               | **0**（修复后）           | 0                          | PASS（修复前 8/15 终端 +0B）  |
| terminal.output JSON 吞吐             | ≤1.1 MiB/s    | —                               | **0.606**（max10s 0.618） | 0.595                      | PASS（原始值照报）            |
| runtime RSS 斜率（末 45s 拟合）       | <1 MiB/min    | —                               | **2.501**（注5）          | **0.362**，平台期≈140.6MiB | 120s 窗 FAIL / 240s PASS      |
| sidecar RSS 斜率                      | <1 MiB/min    | —                               | **0.022**                 | 0                          | PASS                          |
| 队列有界（metrics queued 峰）         | ≤256+16KiB    | —                               | **256.3KiB**              | 256.3KiB                   | PASS（串联合载窗口钉死）      |
| 空闲 CPU（累计 CPU 秒窗差分）         | <5%（§11 ≈0） | **rt 1.6% / sc 0%**             | —                         | —                          | PASS                          |
| 空闲 RSS 峰值                         | 报告值        | rt **77.9–79.0MiB** / sc 3.1MiB | —                         | —                          | 报告                          |
| P2（600s、末 120s 拟合、有界+无卡死） | 见 harness    | —                               | —                         | —                          | **PASS（§9.2，601.7s 实测）** |

P1 洪泛构成：两临时项目 8+8=16 终端（=全局活动额度上限），15×`yes` 洪泛 + 1 控制终端，
100ms 全局 ack 循环（累计最大 seq），每 5s 流式聊天 / 每 2s 控制 PING / 每 10s 存活+吞吐 /
每 5s RSS。聊天 120s 窗 24 条消息全部 completed（含 Run 后记忆提取后台压力）。

**方法注记（AGENTS §9 如实，逐条）：**

1. **harness 边界（最重要）**：延迟测到的是 **runtime 发射事件（`occurredAt`）→ harness
   收到 stdout 行**这一跳，含 TS 全链（入站解析、egress 泵、令牌桶、合帧）与 Rust sidecar
   往返，**不含 Tauri supervisor→`app.emit`→WebView/xterm 渲染跳**。本表数字不能直接当
   "UI 展示延迟"引用；spec §10 门槛原文（"消费至展示"）在本阶段以"发射至协议消费"口径
   实测，口径差如实登记，WebView 跳仍挂 §5/W4 面板验收。
2. **PING 终端不跑 `yes`（15×yes + #1 保持提示符，偏离任务原文）**：一次性 raw-pty 探针
   （`zsh -f -i`，不经本产品）证实 macOS 内核事实——前台 job 运行期间 cooked-mode 输入
   **不回显**（提示符期的"回显"是 zle 重绘，非 ldisc echo；`stty` 显示 `echo icanon` 亦然）、
   内核输入队列约 255B 后**静默丢弃**（60+ 行排队仅 ~2 行最终执行）、约 1KB 未读输入后
   **master write 阻塞**。因此"PING 进忙碌 shell 等回显"在本平台不可实现；改为控制终端保持
   提示符，PING 走完整链路（write RPC→Rust→pty→zsh 真执行→输出回传），是比"内核回显"
   更强的控制面断言。命令用 `echo PING_$(( n ))_X` 使提交回显不含字面 token，检测只命中
   执行输出行；RTT 自发出 write 起算。
3. **ping#1 洪泛起点瞬态**：120s/240s 各只有一个 RTT 离群点（1.6/1.7s），全部是"洪泛开始
   后 0.2s 发出的第一条 PING"——15 终端启动风暴（每终端 ≤256KiB 窗口初灌 + runtime 堆
   预热）所致；其余 p50=13ms/p95=34–35ms。n=59 时单点不影响 p95。样本如实保留未剔除。
4. **egress 指标行来源**：`[terminal-metrics] <id> queued= peak= emitted=` 由 **TS 回传泵**
   写 runtime stderr（`egress.ts report()`），并非 Rust sidecar 自身输出——任务原文"sidecar
   stderr"在本代码库对应"TS 泵 stderr"（Rust 侧无等价行）；harness 按实际来源解析
   （385–769 行/运行），无方法缺口。
5. **120s 窗 RSS 斜率 FAIL = V8 堆预热台阶，非泄漏**：曲线台阶式收敛（0s:92 → 25s:117 →
   60s:134 → 100s:136 → 240s:140.6MiB），台阶全部落在前 ~100s；120s 正式窗的"末 45s"拟合
   罩住 60–65s 的 +13MiB 台阶 → 2.501 MiB/min。240s 延长同门槛复测 **0.362 PASS**。门槛
   数字未动；正式有界性判据是门槛 3 原文"持续 10 分钟"→ 由 P2 末 120s 拟合裁决，
   **已跑，PASS（§9.2）**。
6. **顺带发现的鲁棒性问题（W4-2b 已修复）**：注 2 同因——sidecar 在协议读循环内
   同步 `write_all` 到 master fd（`main.rs` 单循环 → `session.rs write_input`），一个终端
   的内核输入队列满即可卡死**整个 sidecar 请求环**（探针实测一次 `terminal.close` 超时）。
   真实用户等价物是"对忙碌 shell 大量粘贴"。修复涉及输入溢出策略设计（每终端写线程/
   有界队列/非阻塞拒绝码），超出 W4-2a 性能 harness 范围，**登记为 W4 后续项**；
   本 harness 方法（控制终端保持提示符）不触发该路径。
   **W4-2b 修复落地（`96f8b1a`）**：`write_input` 变为纯入队（每终端有界 mpsc，16 槽 ×≤8 KiB，
   吸收前端 4×8 KiB 在飞突发），阻塞式 master write 移入每终端专用写线程（FIFO 保序）；
   溢出确定性返回 `input_backpressure`（TS 映射前端码 `terminal_input_backpressure`，
   definite 臂退避重试一次），输入路径死亡报 `terminal_closed`。复现关键：macOS
   cooked 模式只有**完整短行**积压 ~1 KiB 才阻塞 master write（>255B 单行/无换行碎输入
   被静默丢弃、不产生背压——首轮探针用 8 KiB 无行输入因此"未复现"）。钉死：Rust
   itest6-8、TS passthrough 单测 ×2、`terminal-spike.mjs` check #14
   "busy-shell 输入快速失败不冻主循环"（yes 洪泛下 40×8 KiB 短行猛灌全部即时应答，
   实测最慢 22–25 ms，且期间其他终端/shutdown 不受影响）。
7. **`ps %cpu` 在 macOS 是寿命均值**：空闲门禁用两次采样间 `time=`（累计 CPU 秒）差分的
   窗口占用率，`%cpu` 原值照报；`yes` 洪泛源与 harness 自身的 CPU 不计入门槛（负载发生器）。
8. **清理纪律**：只 TERM/核验本脚本跟踪的 runtime pid、发现到的 sidecar pid 与登记的
   `yes` 孙进程 pid（洪泛开始时快照），绝不按名字宽泛 pkill；120s/240s/P2 冒烟运行
   cleanup 均 `clean:true`（无孤儿）。
9. **Windows/Linux：未验证**（POSIX 主路径，同 §4/§11 口径；`yes` 与 `ps` 格式均 POSIX）。

**压力测试发现的两个后端修复（W4-2a/b，均已入库）**：
① **EgressPacer 轮询公平（`536d6cd`）**——修复前 `EgressPacer.pump()` 每 tick 从
records **插入序**头部开扫、全局令牌桶（一个 16KiB 满事件成本 > 单 tick 补充量）→ 16
终端饱和时首个积压通道吞掉全部额度、其后通道整段窗口 **0 字节**（实测 8/15 终端饿死，
总吞吐 0.56 MiB/s ≈ 单通道独吞速率）。修复：环形游标——每轮从上一轮最后发出者之后开扫
（`egress.ts` 约 +20 行）。新增单测 `egress 饱和轮询：4 积压通道环形分发，无一饿死
（W4 修复）`，变异验证：不带修复时以"前 4 事件未覆盖全部通道"失败，带修复通过。
修复后 P1 全窗口 starve=0、吞吐按预算均匀分布、控制面 p95 34–35ms。
② **终端输入有界写队列（`96f8b1a`）**——见注 6（W4-2b），与 ① 同为压测逼出的
鲁棒性修复，非门槛项本身。

**test-all 决策**：`--quick` 实测 75s wall < 90s，但**不入库**——其 60s 窗的"末 45s RSS
斜率"必然罩住注 5 的堆预热台阶（实测 18.1 MiB/min，结构性必红），且逼近预算线；
test-all 保持现状，正式测量按上方用法手工执行。

**验证**：`pnpm format:check` / `pnpm lint` / 根与前端 `typecheck` /
`pnpm --filter @reflexion-os-studio/runtime test`（229 项，含新单测）/ `cargo fmt --check` +
`cargo test`（crates，本次未改 Rust）全绿；P1 120s 与 240s、P2 20s 机制冒烟结果如上。
P2 正式 600s 已跑，见 §9.2。

### 9.2 P2 长稳正式实测（2026-09-14，`--p2-only` 600s，macOS 26.6.2 / Apple Silicon）

负载构成：两临时项目共 8 终端（7×`yes` 洪泛 + 1 控制终端）、10s PING、30s 流式聊天，
末 120s RSS 线性拟合。原始 summary 行（`/tmp/perf-p2.log`，逐字）：

```text
PERF-SUMMARY {"phase":"P2","pass":true,"seconds":601.7,"pingIssued":59,"pingRttStatsMs":{"n":59,"min":4,"p50":16,"p95":35,"max":1175},"pingWriteRpcStatsMs":{"n":59,"min":0,"p50":1,"p95":7,"max":38},"pingLosses":[],"chatRuns":{"completed":20,"failed":0},"p95ChatMs":1,"rssSlopeMiBPerMin":{"runtime":0.111,"sidecar":0},"egressMaxQueuedKib":256.3,"egressMetricsGap":false,"wedges":[]}
```

**门槛裁决表（spec §10 数字，未放宽）：**

| 门槛               | 阈值            | P2 实测                                                                   | 判定 |
| ------------------ | --------------- | ------------------------------------------------------------------------- | ---- |
| 聊天 delta p95     | ≤100ms          | **1ms**（P2 窗 20/20 completed；P1 1ms n=9600/19200 同口径互证）          | PASS |
| 相对无压力基线增量 | ≤50ms           | **+0ms**（基线 p95_base=1ms，P0 §9.1）                                    | PASS |
| 控制命令响应 p95   | ≤300ms          | **35ms**（n=59；max=1175ms 为注 3 已登记的洪泛起点 ping#1 瞬态单点）      | PASS |
| 控制命令丢失       | 0               | `pingLosses=[]`（59/59 回显）                                             | PASS |
| 持续 10 分钟有界   | 队列/内存不突破 | 601.7s 全程 `egressMaxQueuedKib=256.3`（=256 KiB 窗口封顶，注 5 判据）    | PASS |
| RSS 无持续线性增长 | <1 MiB/min      | 末 120s 拟合 runtime **0.111** / sidecar **0**（注 5 预热台阶已落平台期） | PASS |
| 无卡死（wedge）    | 0               | `wedges=[]`、`egressMetricsGap=false`                                     | PASS |
| 进程清理           | 无孤儿          | `[P2 cleanup] {"clean":true,"notes":[]}`（仅本脚本跟踪 PID，注 8 纪律）   | PASS |

结论：**三项正式门槛全部 PASS**（发射→协议消费口径，注 1）。P1 的 120s 窗
runtime 斜率 FAIL 由本窗（平台期之后）推翻为测量窗口问题，非泄漏——与注 5
240s 复测 0.362 一致。

| 残留项                             | 状态                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| GUI 跳（supervisor→WebView→xterm） | **未测**（注 1 口径；人工清单见 `docs/TERMINAL-GUI-ACCEPTANCE.md`） |
| Windows / Linux                    | **未验证**（同 §4/§9.1 注 9 红线，不宣称三平台完成）                |

## 10. W1 出口清单（Task 15）

| 项                                                          | 状态     | 证据指针                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖版本固定（记录实测版本）                                | done     | §8（lockfile 均入库：`crates/Cargo.lock`/`pnpm-lock.yaml`）                                                                                                                                                                                                                                                                                       |
| 性能门槛固定（不放宽、不改数字）                            | done     | §9（spec §10 原文钉死；量化留 W4）                                                                                                                                                                                                                                                                                                                |
| `pnpm format:check` / `lint` / `typecheck` / 前端 typecheck | done     | Task 15 全链验证（本报告含格式）                                                                                                                                                                                                                                                                                                                  |
| `pnpm build:packages`                                       | done     | contracts→runtime-client→runtime→前端 全绿                                                                                                                                                                                                                                                                                                        |
| `cargo fmt --check` / `cargo test`（crates）                | done     | 109 passed; 0 failed                                                                                                                                                                                                                                                                                                                              |
| `cargo check`（Tauri 宿主）                                 | done     | Finished `dev` profile                                                                                                                                                                                                                                                                                                                            |
| `pnpm test`                                                 | done     | `scripts/test-all.sh` 退出码 0                                                                                                                                                                                                                                                                                                                    |
| `node scripts/check-whitelist.mjs`                          | done     | 7 项 PASS（含 Host 白名单覆盖生成清单）                                                                                                                                                                                                                                                                                                           |
| `pnpm build:desktop`                                        | done     | EXIT=0；产物：`bundle/macos/ReflexionOS Studio.app`（126M）、`bundle/dmg/ReflexionOS Studio_0.1.0_aarch64.dmg`（46M，未签名）                                                                                                                                                                                                                     |
| 打包冒烟（AGENTS §7 第 3 条）                               | done     | 包内二进制启动至 `system-ready`；node/runtime.mjs/system-runtime 三 sidecar 全部从 `.app/Contents/Resources/pkg/` 解析（RESOURCES_OK，无仓库路径泄漏）；TERM 后按包路径 pgrep 无孤儿                                                                                                                                                              |
| 包内代码含终端能力                                          | done     | `runtime.mjs` 含 `terminal.output`；release sidecar（mtime=本次构建）功能探针：`terminal.spawn` 进入参数校验（返回 `terminalId is required`，非 method-not-found）。注：`strings` 查 `"terminal.spawn"` 数据常量在 release 二进制**不可靠**——opt-level 下短字符串比较被编成 memcmp 立即数，字面量不落数据段（debug 二进制含该串），以功能探针为准 |
| Windows / Linux spike + 打包                                | 未验证   | §4 红线：本功能状态为 **macOS 已验证**，不得宣称三平台完成                                                                                                                                                                                                                                                                                        |
| WebView rAF 节流/CPU 量化（§5 #3/#5）                       | deferred | W4 真实面板压力验收补测（§5 人工结论）                                                                                                                                                                                                                                                                                                            |
| 三项延迟/有界性门槛量化测量                                 | deferred | W4（§9 证据范围声明）                                                                                                                                                                                                                                                                                                                             |
| 终端故障矩阵端到端（W4-1）                                  | done     | §11（`scripts/terminal-faults.mjs`，已入 `scripts/test-all.sh`）                                                                                                                                                                                                                                                                                  |
| W4-3 全链门 + 打包冒烟复跑（含 prepare-package 陈旧性修复） | done     | §12（2026-09-14；本表 W1 行由此轮复验覆盖）                                                                                                                                                                                                                                                                                                       |

出口结论：**W1（macOS）达成**。W2 前置项以 §6 清单为准。

## 11. W4-1 故障矩阵端到端自动化（2026-09-13）

- harness：`scripts/terminal-faults.mjs`——驱动**真实链路**（`node apps/runtime/dist/index.js` +
  debug `reflexion-system-runtime`，独立数据目录与 git-less 临时工作区），只用前端协议命令
  （`terminal.*` / `project.*`）覆盖 spec 必测清单中的故障路径：
  create→attach→echo→ack 闭环、attach 超时僵尸保护（failed 事件+额度释放，超时值从构建产物
  `DEFAULTS` 动态读取）、exited/close 竞态（367c094 回收语义：Rust closed 回执吞掉、
  用户 close 静默收敛不发事件）、并发重复 close（双 `closed:true`、恰一条 closed 事件）、
  输入重复序号去重（marker 文件单字节钉死）与乱序间隙过期→`terminal_input_out_of_order`
  稳定码→期望 seq 自愈、sidecar `kill -9` → disconnected + 自动重启 → 新代际可用 +
  旧终端 write 拒绝、16 个 exited 不饿死第 17 个（`too_many_terminals` 回归钉）、
  project.delete 带活动终端（含 sidecar 崩溃后 disconnected 项目的本地收敛路径）。
- 运行成本：≈13s（attach 超时 10s 窗口与额度回收循环重叠），已注册进 `scripts/test-all.sh`。
- **断言范围如实标注**：
  - `terminal_cleanup_failed`（项目删除时任一 close 失败 → 保留项目）分支**只有单测覆盖**
    （`apps/runtime/test/terminal-service.test.mjs` §10，本次补齐——此前该分支连单测都没有）；
    e2e 不测：需要阻塞/失败化的 Rust close，真链路上无法安全构造。
  - 崩溃代际过滤观察到良性现象：重启后新终端的首条 Rust `running` 通知按 sidecar 内部
    代际（1）送达、早于 TS 把记录 generation 从 TS 重启纪元（2）回填，被入站守卫丢弃；
    TS 在 spawn 应答路径同步合成 running，无用户可见丢事件（stderr 有 drop 调试行）。
    留 W4 性能验收一并复核是否需要统一代际口径，**未据此改后端**。
- 验证：连跑 2 次 26/26 PASS（无 flake）；Windows/Linux 路径分支（`taskkill`/PowerShell
  子进程枚举）与本报告 §4 同口径——**未真机验证**。

## 12. W4-3 全链门 + 打包冒烟（2026-09-14，macOS 26.6.2 / Apple Silicon，HEAD `96f8b1a`）

### 12.1 发布入口开关

`apps/desktop/frontend/features/terminal/entry-switch.ts`：构建期
`VITE_TERMINAL_DISABLED='1'` 或运行期 localStorage `terminal.forceDisabled='1'`
（逃生舱，重启后完整生效；会话中途翻转按调用点即时拒绝新建）任一命中即禁用
**入口（新建）**：顶栏终端按钮隐藏（AppMain）、`createTab`/`recreateTab` 拒绝并
toast「终端功能已被禁用」、禁用启动时面板强制收起。**已打开的终端不静默杀**
（spec §10 回滚流程负责统一关闭；见 entry-switch WHY 注释）。前端无测试
runner，以 `pnpm build` 全绿 + 源码 grep 断言佐证。

### 12.2 全链门记录

| 门                                                                                       | 结果                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm format:check` / `pnpm lint` / 根 `typecheck` / 前端 `typecheck`                    | PASS                                     |
| `pnpm build:packages`                                                                    | PASS（chunk >500kB 警告为既有）          |
| `cargo fmt --check`（crates）/ `cargo test`（crates）                                    | PASS / 173 passed; 0 failed              |
| `cargo check`（Tauri 宿主）                                                              | PASS                                     |
| `bash scripts/test-all.sh`（runtime 测试 + terminal-faults 26/26 + check-whitelist 7/7） | PASS（退出码 0）                         |
| `node scripts/terminal-spike.mjs`                                                        | 14/14 PASS                               |
| `node scripts/terminal-faults.mjs`                                                       | 26/26 PASS（13.1s）                      |
| `pnpm build:desktop`                                                                     | 见 12.3（首轮红→修复→复跑 EXIT=0）       |
| Windows / Linux 全部真机项                                                               | **未验证**（红线不变，不宣称三平台完成） |

### 12.3 打包冒烟（AGENTS §7 第 3 条）与一次真实的打包缺陷修复

- **首轮 FAIL（证据链）**：`fetch-node-dist.mjs` 对 nodejs.org 的 SHASUMS 拉取
  遇瞬时 TLS ECONNRESET（重试即过，未改脚本）；重跑后构建 EXIT=0，但包内
  二进制启动实测 `[runtime] system.ready rejected: expected protocol 1.1, got
1.0` → sidecar 被握手拒绝、重启预算耗尽后**永久 degraded**。根因：
  `prepare-package.sh` 对 release sidecar「**仅缺失才构建**」，把 09-13 的陈旧
  `crates/target/release` 二进制（早于 W0 协议 1.1 的本地构建）原样打进包。
- **修复（本轮唯一代码外变更）**：`prepare-package.sh` 改为**每次
  `cargo build --release`**（cargo 增量，新鲜时秒级 no-op），杜绝陈旧产物入包。
- **复跑冒烟（修复后，包内二进制直接启动）**：
  - 三 sidecar 全部从 `.app/Contents/Resources/pkg/` 解析，无仓库路径泄漏：
    `pkg/node/bin/node` → `pkg/runtime/runtime.mjs`（PPID=宿主），
    `pkg/bin/reflexion-system-runtime`（PPID=node）；
  - 状态机：`starting → runtime-ready → system-ready`（`system runtime ready:
0.3.0`，无 degraded/error）；
  - 功能探针（release 二进制，PID 树内）：包内 `runtime.mjs` 含
    `terminal.output`×5；包内 sidecar `terminal.spawn` 进入参数校验
    （返回 `terminalId is required`，非 method-not-found）；
  - `TERM` 宿主后按跟踪 PID（31683/31700/31930）与 `.app` 路径双重 pgrep：
    **无孤儿**。
- 产物：`bundle/macos/ReflexionOS Studio.app`（126M）、
  `bundle/dmg/ReflexionOS Studio_0.1.0_aarch64.dmg`（46M，未签名）。
- 清理纪律：仅操作本会话启动并记录的 PID；用户 dev 栈（PID 73586/95537 等）
  全程未触碰。
