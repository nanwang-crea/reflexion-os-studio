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

出口结论：**W1（macOS）达成**。W2 前置项以 §6 清单为准。
