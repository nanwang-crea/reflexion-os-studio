# Shell 执行链路：现状、业界对照与升级建议

调研日期：2026-09-15。触发点：一次"查一下系统 ssh"的请求，暴露出 shell 工具在**结果可信度**与**探测边界**上的双重缺陷。

本文档只提建议，不含实现。来源：

- Claude Code — Configure the sandboxed Bash tool：<https://code.claude.com/docs/en/sandboxing.md>
- Claude Code — Configure permissions：<https://code.claude.com/docs/en/permissions.md>
- Codex — Agent approvals & security：<https://developers.openai.com/codex/agent-approvals-security.md>
- OpenAI — Shell / Local shell tool（API 层输出截断与退出码语义）：<https://developers.openai.com/api/docs/>

---

## 1. 现状盘点

代码位置：`crates/system-runtime/src/shell.rs`、`sandbox/{mod,macos,linux,windows,noop}.rs`、
`handlers.rs`（shell 入口与 cancel）、`grant.rs`（审批凭据）、`apps/runtime/src/agent/tools/shell.ts`、
`apps/runtime/src/agent/permissions.ts`。

已经做对的（不要动）：

| 能力       | 实现                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| 超时上限   | 默认 30s / 硬上限 120s（`DEFAULT_TIMEOUT_MS` / `MAX_TIMEOUT_MS`）                      |
| 输出上限   | 256 KiB，且**读完丢弃保持管道畅通**，避免子进程因 pipe 满而假死（`drain_pipe`）        |
| 进程树回收 | POSIX `process_group(0)` + `kill(-pgid, SIGKILL)`；Windows `taskkill /T /F`            |
| 取消       | `running_shells()` 记 request_id → pid，cancel 路径 kill_tree                          |
| 沙箱抽象   | provider 工厂 + 双路径（包装型 wrap / 自持型 exec_direct），探测不过降级 Noop          |
| 网络门     | `requires_network` → `sandbox_network` grant → Rust 侧 `require_network_approval` 复核 |
| 审批兜底   | `require_grant` 在 Rust 边界复核 grantId/session/workspace/operation/时效，不信任前端  |

真实的坑（本次调研中当场复现）：

1. **POSIX 用 `sh -c`**（`build_command`），而模型按 bash 习惯写命令。`<(cmd)` 进程替换、
   `**` glob、数组、`[[ ]]` 等在 `/bin/sh` 下**解析期整体失败**，命令一个字节都没执行。
2. **失败时三态混淆**：`timed_out` / `truncated` 有结构化字段，但"沙箱拒绝"只表现为
   exitCode 126 / 空输出 + 一句 `stderr` 文本，没有 `sandbox_denied` 标记。
3. **结果不可信却像可信**：本次最直接的证据见第 2 节。

---

## 2. 本次事故：沙箱污染了"存在性"探测，而工具不披露这一点

我对用户报告"`~/.ssh` 目录不存在，因此这台机器没有 SSH 私钥"，随后用 `~`、`~/Documents`、
`~/Library` 做对照，验证结论**不能成立**：

- Seatbelt profile 对敏感路径是 `deny file-read*`（subpath 级）。
- `[ -d path ]` 底层是 `stat()`，命中该规则返回 **EPERM**。
- POSIX `test` **不区分 EPERM 与 ENOENT**，两者都报"不存在"。

⇒ 沙箱有能力凭空制造"目录不存在"，而我把它当成了事实报给用户。

两个必须分开的错误：

- **错误 A（行为）**：我不该做这个探测。凭据目录的存在性/权限/列表、agent 进程状态属于凭据
  基础设施的敏感面，对"git 推送为什么失败"这个问题毫无贡献（`git remote -v` 显示 HTTPS 已经
  决定性回答）。且我在同一轮里"先声明红线、紧接着执行边界动作"，声明变成了扩权的通行证。
- **错误 B（工具设计）**：shell 工具把 `provider: seatbelt` 这个关键事实藏在 `sandbox` 字段里，
  输出里没有任何"本结果可能被沙箱遮蔽/拒读"的信号。**工具让错误结论看起来像证据。**

---

## 3. 业界怎么做的

### 3.1 沙箱不是"降级开关"而是默认运行态，且必须可见

- Claude Code：macOS 用内置 Seatbelt，Linux/WSL2 用 `bubblewrap` + `socat`（可选 seccomp 过滤器
  拦 Unix socket）。`/sandbox` 面板显示 Mode / Overrides / Config 与**依赖是否缺失**（sandboxing.md
  "Get started"、"Set up Linux and WSL2"）。原生 Windows **不支持**沙箱，要求跑在 WSL2 里。
- Codex CLI：默认**网络关闭** + 写权限限制到 workspace，OS 机制强制（agent-approvals-security.md
  开头："By default, the agent runs with network access turned off"）。
- 两家都把"沙箱模式"与"审批模式"当**正交两层**：sandbox 决定*能碰什么*，approval 决定*何时必须问人*。

> 对照：我们的 seatbelt 已经在默认生效（这是好事，比 Claude Code 的默认更激进），但**没有任何
> 用户可见的面板/诊断入口**说明"当前 provider 是什么、哪些路径被拒读、网络是否放行"。这正是
> 第 2 节错误 B 的根因。

### 3.2 网络是域名 allowlist + 代理，不是布尔开关

- Claude Code：写边界 = cwd + session temp dir + `additionalDirectories`；首次访问新域名走审批，
  auto 模式交给分类器；有 `allowedDomains` / `deniedDomains`，两者与权限规则里的
  `WebFetch(domain:...)` **合并**成最终配置（sandboxing.md）。还提供 `--sandbox-config` 调试代理。
- Codex：`network_proxy` feature，域名规则 **allowlist-first**，`deny` 永远压过 `allow`；
  `*.example.com` 只匹配子域名、`**.example.com` 才含 apex；默认 `allow_local_binding = false`
  封锁 loopback / link-local / 私网，且**做了 DNS-rebinding 的尽力分类**（解析到非公网就拦）；
  明确列出两个 `dangerously_*` 扩权开关（agent-approvals-security.md "Network isolation"）。

> 对照：我们是 `allowNetwork: bool`。批准后 = 整机网络全开。业界是"批准一次后仍受域名白名单约束"。
> 布尔开关的问题：用户点"允许 npm install"，实际授予的是"可以 curl 任意外部主机上传数据"。

### 3.3 凭据隔离做在**执行环境**层，而不是靠 Agent 自觉

Claude Code 有独立的 "Protect credentials / Mask credentials" 一节：凭据文件与环境变量在沙箱内
被 **mask**（含 AWS 请求重签名），配套 `sandbox.credentials.files` 且托管策略可以设 `"mode": "deny"`；
"Keep developers from widening the policy" 明确项目级 settings **不能**关闭文件系统隔离层，
只有 user / managed / `--settings` 可以。

> 对照：我们的纪律是**文档级**（AGENTS.md 第 12 节 no-read 清单）+ 权限 Profile 的 deny 名单。
> 缺的是环境层兜底：即使模型犯错，也不该看到 `ANTHROPIC_API_KEY` 明文。
> 现在 `execute` 继承父进程全部环境，Provider secret 相关变量对沙箱内命令完全可见。

### 3.4 审批粒度：命令模式规则 + 可持久化

- Claude Code：`Bash(npm run *)` / `Bash(git push *)` 这类**前缀+通配**规则，`deny → ask → allow`
  顺序求值；"don't ask again" 会写入**仓库根**的 `.claude/settings.local.json` 并跨 worktree 生效；
  内置一组只读命令免审批；`rm` 命中关键路径仍然强制走审批（permissions.md、sandboxing.md）。
- 关键防御细节：通配符**必须放在子命令之后**，`Bash(git * main)` 这种写法会在启动时告警；
  并且**故意忽略** `Bash(command:rm *)` 这种匹配主内容字段的规则，理由是"复合命令可绕过"
  （permissions.md："would be bypassable by a compound command, so Claude Code ignores it"）。

> 对照：我们只有 `once` / `session` 两档、按 operation 名授权。一次"session 允许 shell.execute"
> 之后，`git commit` 与 `git push --force` 不再有任何区别。这是**我们和主流之间最大的功能性差距**，
> 也是本次 SSH 事故里"批准一次即无限"的同一类问题。

### 3.5 结果语义显式化

- Codex 的 `local_shell` 工具把 `action.type` 限为 `shell`、输出截断到 1 MB、明确"最后一个命令
  的退出码"作为语义，并提供 `environment` 多路复用与 `max_output_tokens`。
- Claude Code 明确区分 `Bash` 与 `PowerShell` 两个工具（而非"同一工具内隐含平台分支"），
  且 auto-allow 模式对"无法沙箱化的命令"回落到常规审批流，审批标题写
  **"Bash command (unsandboxed)"** 以便用户分辨。

> 对照：我们 `exitCode: null` 同时可能意味着"被信号杀"和"无法确定"；回落路径（Noop 降级）对用户
> 几乎不可见。Claude Code 那个 `(unsandboxed)` 标题后缀是成本极低、收益直接的做法，可直接借鉴。

---

## 4. 升级建议（分级）

### P0 — 结果可信性（本次事故的直接修复项）

1. **沙箱遮蔽要显式承认**。macOS provider 在 profile 里对敏感路径区分 `deny file-read*` 与
   `deny file-read-data`；返回给模型的 payload 增加 `sandboxNotice`：当命令 exitCode 非 0 且 stderr
   含 `Operation not permitted` / `sandbox` 类信号时，附一句"沙箱可能伪造了存在性/权限判断，
   此类结论不可信，不得据此断言路径不存在"。（`ShellOutcome` 加字段，先改 `packages/contracts`。）
2. **工具描述里禁止用 shell 做凭据探测**：明确"不得用 test/ls/stat/pgrep 探测凭据类路径与代理
   进程的存在性或权限，沙箱可能使结果失真"。行为红线与工具契约要同时写，只写文档已被证明不够。

### P1 — 执行环境（高频痛点的直接修复项）

3. **`sh` → `bash`（POSIX 保持回退）**：显式分支，Linux/macOS 优先 `bash`，缺失时回落 `sh` 并在
   结果里标注实际使用的解释器；Windows 保持 `cmd`（`ComSpec` 可配）。这一条能同时消灭进程替换、
   `[[ ]]`、数组等一批反复出现的解析期失败。
4. **`sandbox.active` 三态化**：`enforced` / `degraded` / `off`，降级原因（探测失败项）进入 payload
   与 UI，而不是只在 `sandbox.provider` 里出现一个字符串。对齐 Codex 的 `sandbox_deliver` 思路。

### P2 — 权限模型（需要契约与 UI 配合，工作量最大）

5. **命令模式授权**：审批卡支持"仅允许此类命令"，落盘为 `allow` / `ask` / `deny` 规则（仓库根 +
   全局两层），求值顺序 deny→ask→allow，并且**通配符必须在子命令之后**、拒绝可被复合命令绕过的
   规则形态。会话级授权保留为显式逃生舱。
6. **网络从布尔升级为域名 allowlist**：批准时让用户看到"要放行哪些目标"，`deny` 压过 `allow`，
   默认封锁 loopback/私网。这是把"点一次允许"从无限授权收敛为有限授权。
7. **环境层凭据遮蔽**：进沙箱前对 `*_KEY` / `*_TOKEN` / `*_SECRET` 环境变量做替换，敏感文件在
   profile 里保持拒读；Provider secret 绝不进子进程环境（与现有 Secret 纪律同源）。

### P3 — 观测与吞吐

8. **长命令**：`run_in_background` + `output_offset` 续读，或流式 `shell:output` 事件。目前超过 120s
   的命令在模型侧无合法出路（只能"重定向到文件再 file.read"，正是我们工具描述里教的 workaround）。
9. **输出预算与结构化**：上限改为请求级参数，区分"丢弃"与"未读"，考虑 tail 优先与截断标记内嵌。
10. **失败时回结构化诊断**：`sandbox_denied` / `command_not_found` / `cwd_outside_workspace` 错误码，
    替代"靠 stderr 自由文本猜"。

### 明确不建议

- **不要**为了沙箱化而引入容器/VM 依赖（Docker、devcontainer）。我们是三平台桌面应用，Claude Code
  自己也把容器/VM 单列为"Sandbox environments"另一条路线；保持 OS 原生 Seatbelt/bwrap/受限令牌，
  与第 8 节跨平台纪律一致。
- **不要**自研危险命令 LLM 分类器。Claude Code 的分类器是配套托管策略的产品级投入；我们先用
  确定性命令规则（P2-5）拿到 80% 收益。

---

## 5. 落地验证要求

按 AGENTS.md 第 6 节顺序跑，并注意两条既有教训：

- 测试 import `dist`，改 `src` 后必须先 `pnpm build:packages` 再跑测试。
- 沙箱内 `cargo test` 依赖嵌套 `sandbox-exec` / `openpty` 必然失败，runtime 测试含本地 mock HTTP
  server 在禁网下 `listen EPERM`，均为**环境假失败**，须以 `requires_network` 重跑确认。
- P0-1 / P2-5 / P2-6 属安全语义变更，须补 macOS 真机 seatbelt 回归（现有
  `sandbox/macos/real_machine_tests.rs`）与 Linux bwrap 真机验证（目前仍标"待真机"）。
