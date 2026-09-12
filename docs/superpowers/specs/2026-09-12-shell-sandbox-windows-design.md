# Shell 沙箱：Windows 受限令牌档 + 网络审批闭环 设计

> 日期：2026-09-12。状态：已评审（brainstorming 流程产出）。
> 上游文档：[SHELL-SANDBOX-PLAN.md](../../SHELL-SANDBOX-PLAN.md)（一期计划，本设计是其扩展与部分实现）。
> 决策依据：2026-09-12 设计会话；对照 codex 官方文档（Agent approvals & security、
> Windows sandbox）、codex-rs 架构、ReflexionOS 本地实现（`backend/app/security/sandbox/windows*.py`
> 及其 2026-07-02 实施计划）。

## 1. 背景与目标

`SHELL-SANDBOX-PLAN.md`（一期）尚未实现。本设计在同一框架内确定三件事：

1. **沙箱骨架落地**：`SandboxProvider` trait + 工厂 + 协议能力位，使 macOS（Seatbelt）与
   Windows（受限令牌）都能以平台子类形式挂入，而不是文档里的口头约定。
2. **Windows 沙箱实现**：受限令牌 + 低完整性 + Job Object 档（对齐 codex 官方
   `unelevated` 档），Windows 不再是"维持 cmd /C 现状"。
3. **按命令网络授权（原计划 S3）**：`requires_network` → 独立审批卡 → grant 携带
   `sandboxNetwork` 声明 → Rust 核对。对齐 codex 的"网络是需要审批的越界行为"语义。

### 与 codex 的一致性对照（决策依据）

| 维度 | codex | 本设计 | 结论 |
| --- | --- | --- | --- |
| Windows 沙箱档位 | `elevated`（专用沙盒用户+防火墙，需管理员）/ `unelevated`（受限令牌+ACL 边界，弱网络隔离） | 只做 unelevated 同族；elevated 记为未来项 | 一致（选 fallback 档） |
| 网络越界 | 按命令/动作审批（"asks for approval … to run commands that require network access"） | `requires_network` 声明 → 审批卡 → grant 声明 → Rust 核对 | 一致（我们是先审批后执行，codex 是失败后升级重跑，语义等价） |
| 双层模型 | 沙箱模式（技术边界）+ 审批策略（何时询问），互相独立 | 沙箱 provider（OS 边界）+ 审批管线（流程边界），互相独立 | 一致 |
| trait 形状 | codex-rs：seatbelt/landlock 包装命令，Windows 自持 spawn | 双路径 trait：`wrap`（包装）+ `exec_direct`（自持） | 一致 |

## 2. 范围

### 本轮实现

1. `crates/system-runtime/src/sandbox/` 模块：trait + 工厂 + `NoopSandbox` + Windows
   provider（`#[cfg(windows)]`）。
2. `shell.execute` 接线：经工厂分发（exec_direct 或 wrap+现有 shell.rs）；result 增加
   `sandbox` 元数据；`system.ready` 增加 `sandbox` 能力位。
3. `shell.execute` params 增加 `allowNetwork`（Rust 侧解析 + grant 核对）。
4. 网络审批闭环（TS）：工具参数 `requires_network`、`sandbox_network` 审批生成、grant
   payload 增加 `sandboxNetwork`、前端审批卡标签。

### 非目标（保留决策位，不在本轮）

- **Seatbelt provider**（macOS OS 级沙箱）与登录 shell 环境（原计划 S1/S2 的 macOS 部分）——
  下一轮；本轮 macOS 工厂返回 Noop。
- **Linux bwrap**、codex `elevated` 档（专用沙盒用户 + netsh 防火墙 + UAC setup）、
  私有桌面（`windows.sandbox_private_desktop` 对应物）、codex 式 network_proxy 域名策略；
- **codex 式可写根内保护路径**（`<root>/.git`、`.codex` 等只读化）：Windows 完整性标签
  方案可对子目录打更高级别标签实现，留作后续加固项（对齐 codex "Protected paths in
  writable roots"）。
- 沙箱能力位的前端 UI 展示（原计划 S4 的页面部分）。
- deny-default 严格模式（codex `workspace-write` 式白名单）。

## 3. 架构：双路径 Trait + 工厂

```rust
// crates/system-runtime/src/sandbox/mod.rs
pub struct SandboxRequest {
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_ms: u64,
    pub allow_network: bool,
}

pub trait SandboxProvider: Send + Sync {
    /// "windows-token" | "none"（下轮追加 "seatbelt" / "bwrap"）
    fn id(&self) -> &'static str;
    fn is_available(&self) -> bool;
    /// 自持执行路径（Windows：CreateProcessAsUserW，无法用"包装"表达）。
    /// 返回 None 表示本 provider 走包装路径。
    fn exec_direct(
        &self,
        request: &SandboxRequest,
        on_spawn: &dyn Fn(u32),
    ) -> Option<Result<shell::ShellOutcome, String>> {
        let _ = (request, on_spawn);
        None
    }
    /// 包装路径：改写命令字符串（Seatbelt 下轮：sandbox-exec -p <profile> -- …）。
    fn wrap(&self, command: String) -> String { command }
}
```

**为什么双路径**（ReflexionOS 2026-07-02 计划的实测教训）：Seatbelt/bwrap 是"包装命令"
（前缀一个 launcher），Windows 受限令牌必须"自己 spawn 进程"（CreateProcessAsUserW），
`wrap` 形状装不下它；ReflexionOS 因此给基类补了 `run_command`/`run_shell_command`
自持方法。双路径 trait 是该教训的 Rust 化。

**工厂**（`OnceLock`，进程内选定一次）：

- Windows：探测 `WindowsTokenSandbox::probe()`（OpenProcessToken + CreateRestrictedToken +
  完整性级别设置的干跑）；成功 → `windows-token`，失败 → `none`。
- macOS/Linux：本轮直接 `none`（Seatbelt/bwrap 下轮挂入工厂的对应 cfg 分支）。
- **选定后不回退**（fail-closed）：provider 探测通过但运行期执行失败 → 结构化错误如实上报，
  绝不静默降级为无沙箱执行；`none` 降级只发生在工厂探测阶段。

**handlers.rs 分发**（`handle_shell_execute`，改动点集中）：

```text
provider = sandbox::provider()
match provider.exec_direct(&request, &on_spawn):
    Some(result) → result（active = true）
    None         → shell::execute(&provider.wrap(command), …)（active = provider.id() != "none"）
result 增加 "sandbox": { "active": bool, "provider": id }
```

## 4. Windows Provider 机制（`sandbox/windows/`，全部 `#[cfg(windows)]`）

### 4.1 受限令牌（`token.rs`）

- `OpenProcessToken`（TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY）→
  `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE, SidsToDisable=[Builtin\Administrators])`；
- `SetTokenInformation(TokenIntegrityLevel, LOW)`；
- 令牌句柄进程内缓存（`OnceLock`），探测与执行共用同一句柄；
- 语义：进程失去全部特权与管理员能力（防提权）。

### 4.2 文件写边界（`acl.rs`）

- 对可写 root 调 `SetNamedSecurityInfoW` 打 LOW 强制完整性标签
  （SACL `S:(ML;;OICI;;;LW)`，OI/CI 继承）；可写 root = **workspace root + 专用沙盒
  临时目录**（`<TEMP>/reflexion-sandbox`，通过 TMP/TEMP 环境变量重定向给沙盒子进程；
  不给整个用户 TEMP 打标签——标签会放宽该目录的完整性约束，副作用过大）；
- 低完整性进程只能写 LOW 标签目录 → **仅 workspace/沙盒临时目录可写**（Chrome 模型，与
  macOS Seatbelt 一期的写边界语义一致）；
- 已打标签的 root 缓存于 `Mutex<HashSet<PathBuf>>`（幂等，避免每命令重复设 ACL）；
- 标签设置失败 → provider 整体不可用（fail-closed），不允许"半沙箱"。

### 4.3 进程执行（`launch.rs`）

- 匿名管道（SECURITY_ATTRIBUTES 可继承）捕获 stdout/stderr；
- `CreateProcessAsUserW(token, cmd /C <command>, CREATE_SUSPENDED | CREATE_NO_WINDOW, cwd)`；
- `CreateJobObjectW` + `SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)` +
  `AssignProcessToJobObject` → `ResumeThread`；
- `on_spawn(pid)` 注册进 `running_shells`（`system.cancel` 树杀路径不变，taskkill 对
  Job 内进程仍然有效；Job 关闭兜底收割）；
- 超时 → `TerminateJobObject`（整树终止，强于现有 taskkill 语义）；
- 输出读取/上限/超时轮询语义与 `shell.rs` 对齐（256 KiB 截断、25ms 轮询）。

### 4.4 如实声明的能力边界（写入用户可见文档）

| 能力 | macOS Seatbelt（下轮） | Windows-token（本轮） |
| --- | --- | --- |
| 网络强制禁断 | ✅ `deny network*` | ❌ **不强制**（审批是流程性闸门，同 codex unelevated） |
| 写边界 | workspace + TMPDIR | workspace + TMPDIR（完整性标签） |
| 敏感路径读保护 | ✅ deny `~/.ssh` 等 | ❌ 完整性级别不限制读 |
| 提权保护 | （沙箱内） | ✅ 剥离特权 + 移除管理员 SID |
| 副作用 | 无 | workspace 目录 ACL 增加 LOW 标签（持久化，幂等重设；LOW 标签文件任何完整性可写，权衡记录在案） |

## 5. 按命令网络授权（S3）

### 5.1 流程

```text
模型调用 shell.execute{command, requires_network?}
  → PermissionGate：shell.execute 决策照旧（ask / trusted-automatic）
  → 工具执行前：requires_network === true 时
      hasSessionGrant("sandbox_network") ? 复用
      : ApprovalGateway.request({ operation: "sandbox_network", summary: command })
        → 审批卡（允许一次 / 本会话允许）
  → grant payload 携带 sandboxNetwork: true
  → Rust require_grant：allowNetwork=true 而 grant.sandboxNetwork≠true → 拒绝
  → 沙箱执行（本轮 Windows/Noop 均不 OS 强制；Seatbelt 落地后自动升级为 OS 强制）
```

### 5.2 约束与语义

- **trusted 模式不旁路网络审批**：trusted 自动放行 `shell.execute`（现有语义不变），
  但 `sandbox_network` 始终走审批卡——网络是独立链路，任何模式不自动放行
  （对齐 ReflexionOS "任何 mode 都不旁路"）。
- **会话级放行**：scope=session 存 `ApprovalGateway.sessionGrants`（键含 operation），
  本会话后续网络命令免二次询问；进程重启失效（现有语义）。
- **grant 结构**：operation 仍为 `shell.execute`；payload 增加可选
  `sandboxNetwork: bool`（`#[serde(default)]`，兼容在途旧 grant）。
- Rust 核对失败错误码：`network_approval_required`（区别于 `invalid_grant`）。

### 5.3 改动点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| TS 工具 | `apps/runtime/src/agent/tools/shell.ts` | 参数 + `requires_network`（description 提示"需联网命令必须声明，否则未来沙箱内必失败"） |
| TS 审批 | `apps/runtime/src/agent/permissions.ts` | `buildOnceGrant`/`buildSessionGrant` GrantIdentity 增加可选 `sandboxNetwork`；网关复用不变 |
| TS 执行 | `apps/runtime/src/agent/tool-executor.ts` | requires_network 时先取/生成 `sandbox_network` 授权，拼进 grant |
| Rust | `crates/system-runtime/src/params.rs` | `ShellParams.allow_network: Option<bool>` |
| Rust | `crates/system-runtime/src/grant.rs` | ApprovalGrant 增加可选 `sandbox_network`；allowNetwork 核对 |
| 前端 | `features/chat/ApprovalCard.tsx` | `OPERATION_LABELS` + `'sandbox_network': '允许命令联网'` |

## 6. 协议变更（全部向后兼容）

| 消息 | 变更 |
| --- | --- |
| `shell.execute` params | + `allowNetwork: boolean`（可选，缺省 false；deny_unknown_fields 下可选字段安全） |
| `shell.execute` result | + `sandbox: { active: boolean, provider: "windows-token" \| "none" }`（枚举开放，未来 `seatbelt`/`bwrap`） |
| `system.ready` params | + `sandbox: "windows-token" \| "none"`（同上枚举） |

TS 侧零破坏：result 新字段向后兼容；params 新字段可选。工具结果含 `sandbox` 元数据随
现有 toolCall 轨迹存储展示，无专门 UI。

## 7. 降级与错误处理

| 场景 | 行为 |
| --- | --- |
| Windows 探测失败（令牌/完整性设置不可用） | 工厂选 `none`；ready 能力位如实为 `none` |
| 选定后执行失败（spawn/管道/Job 错误） | 结构化错误（`execution_failed` + 明确 message），不回退无沙箱执行 |
| allowNetwork=true 但 grant 无 sandboxNetwork | `network_approval_required` 错误，TS 侧不会出现（审批先行），此为绕过兜底 |
| macOS/Linux | 工厂返回 `none`，行为与现状完全一致（`sh -c` 路径不动） |
| sandbox.cancel / system.cancel | 现有 `running_shells` + `kill_tree` 路径不变；Job 兜底收割 |

## 8. 测试与验证

- **平台无关单测**（cargo test，本地 macOS）：工厂在非 Windows 返回 `none`；noop wrap
  恒等；params `allowNetwork` 缺省 false；grant.rs 的 sandboxNetwork 核对（含缺省字段、
  allowNetwork=true 无声明 → `network_approval_required`）；现有 shell.rs 测试全绿。
- **Windows 编译级验证**：`rustup target add x86_64-pc-windows-msvc` +
  `cargo check --target x86_64-pc-windows-msvc`。**运行时行为未经真机验证**（无 Windows
  机器），交付说明如实标注；真机验收项（token 生效、workspace 外写被拒、Job 树杀）记入
  SHELL-SANDBOX-PLAN.md 验收表留待 Windows 环境。
- **TS 侧**：现有 approval 管线测试模式沿用；`pnpm lint` / `pnpm typecheck` 全链。
- **依赖**：`crates/system-runtime` 增加 `[target.'cfg(windows)'.dependencies] windows =
  { … }`（官方 windows crate；具体 feature 清单在实施计划中固定，仅 Windows
  target 编译，macOS 构建不受影响。

## 9. 文档更新

- `docs/SHELL-SANDBOX-PLAN.md`：§2 非目标移除 Windows；§4.2 更新为双路径 trait（记录
  ReflexionOS 教训）；新增 Windows provider 一节（指向本 spec）；§4.4 枚举更新；§5 增加
  Windows 步骤与真机验收项；§6/§7 风险与决策记录刷新。
- `docs/PERMISSION-MODEL.md`：L77 平台级沙箱表述更新为指向本设计（shell 域已启动
  Windows 档）。
- `AGENTS.md`：阶段清单补记本能力（Windows 受限令牌沙箱 + 网络审批）。

## 10. 决策记录

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| Windows 机制档位 | 受限令牌 + 低完整性 + Job Object（codex unelevated 同族） | 免管理员；elevated/UAC/防火墙档桌面体验差；ReflexionOS 已趟通同构路线 |
| trait 形状 | 双路径（wrap + exec_direct） | Windows 无法用命令包装表达；ReflexionOS 2026-07-02 实测教训 |
| 按命令网络授权 | 本轮纳入（S3） | codex 同语义；避免发布无人消费的 allowNetwork 孤儿参数；审批管线现成 |
| trusted 与网络审批 | 不旁路 | 网络独立链路，任何模式不自动放行 |
| Windows 网络强制 | 不做，如实上报 | 无免管理员机制；同 codex unelevated 诚实标注"弱网络隔离" |
| 沙盒临时目录 | 专用子目录 + TMP/TEMP 重定向 | 给整个用户 TEMP 打 LOW 标签副作用过大（放宽完整性约束） |
| fail-closed | 探测后不回退 | 静默降级为无沙箱是最坏状态；降级只允许发生在工厂探测期 |
