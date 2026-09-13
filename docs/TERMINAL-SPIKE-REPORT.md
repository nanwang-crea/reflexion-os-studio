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

## 5. WebView / xterm

**Pending——Task 14 未执行**（隐藏实例解析、跨 write 半字符 UTF-8、rAF 后台
节流、resize/fit、空闲 CPU）。本报告不声称任何 WebView 侧结论；W3 保活面板
方案以 Task 14 结论为准。

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
- 对计划脚本的两处非语义偏差：① 计划版 `floodStart` 声明未用（ESLint 报
  no-unused-vars），改为以实测 elapsed 计算速率（原计划按 3s 名义值）；
  ② 单帧检查追加实测 max 帧细节。断言强度未降低。
- 一次性探针（§2 PID 级、§4 trap）不入库；trap 探针产生的孤儿进程已当场清理。
- Windows/Linux spike、WebView/xterm 检查单：未做（分别待对应环境与 Task 14）。
