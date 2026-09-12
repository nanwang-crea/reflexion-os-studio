# Shell 沙箱轮次 B：macOS Seatbelt + Linux bwrap + trait argv 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `SandboxProvider` 从"仅 Windows 有真 provider"扩展为三平台全覆盖：trait `wrap` argv 化重构（携带请求上下文）→ macOS Seatbelt（**本机真机验收**）+ Linux bwrap（编译级 + 渲染器单测），并把 Noop 降级语义收敛到"探测阶段"。

**Architecture:** spec §11–§13（`docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md`，轮次 B 修订已入库）。`sandbox/macos.rs` 与 `sandbox/linux.rs` **不加 cfg 门全平台编译**（纯渲染 + std::process 探测），渲染器单测在开发机可跑；`select()` 按 cfg 分支挂 provider。`shell.rs` 抽出 argv 内核 `run_command`，新增 `execute_argv`。Windows 路径（`exec_direct`）语义零改动。

**Tech Stack:** Rust（无新依赖，seatbelt/bwrap 都是外部二进制包装）、`node:test`（仅措辞级 TS 改动）。

**验证边界（必须如实执行与汇报）:**

- macOS：provider 全行为**真机验证**（本机即验收环境）——这是轮次 B 的主验证面，越界写/拒读/禁网必须有测试证据。
- Linux：本机无 Linux。验证 = 渲染器单测（全平台可跑）+ `cargo check --target x86_64-unknown-linux-gnu` 编译门；**运行时行为未验证**，交付如实标注。
- Windows：trait 重构触及共享分发代码，每个任务必须保持 `cargo check --target x86_64-pc-windows-msvc` 绿 + 现有 75 测试全绿。
- 计划中的 profile/args 种子代码若与真机行为不符（seatbelt 白名单不够用），按 Task 3 的迭代步骤修白名单，**验收测试为准绳，禁止为了过测试放宽 deny 核心语义**（deny default / 拒读 / 无网不得软化）。

---

### Task 1: shell.rs argv 内核 + trait wrap argv 化 + handler 分发

**Files:**

- Modify: `crates/system-runtime/src/shell.rs`（L25-100 区域重构 + 新 API）
- Modify: `crates/system-runtime/src/sandbox/mod.rs`（wrap 签名、工厂测试、mod 声明预留）
- Modify: `crates/system-runtime/src/sandbox/noop.rs`（无需改动则不动）
- Modify: `crates/system-runtime/src/handlers.rs`（`handle_shell_execute` 分发块）

- [ ] **Step 1.1: 写失败测试（execute_argv）**

`shell.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn execute_argv_captures_output_and_env_override() {
        let cwd = temp_dir("argv-basic");
        let outcome = execute_argv(
            &["sh".to_string(), "-c".to_string(), "printf \"$SANDBOX_MARK\""
                .to_string()],
            &[("SANDBOX_MARK", "argv-ok")],
            &cwd,
            10_000,
            &|_| {},
        )
        .unwrap();
        assert_eq!(outcome.stdout, "argv-ok");
        assert_eq!(outcome.exit_code, Some(0));
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn execute_argv_reports_spawn_failure() {
        let cwd = temp_dir("argv-missing-bin");
        let error = execute_argv(
            &["definitely-not-a-real-binary".to_string()],
            &[],
            &cwd,
            1_000,
            &|_| {},
        )
        .unwrap_err();
        assert!(error.contains("spawn failed"));
        std::fs::remove_dir_all(&cwd).ok();
    }
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cargo test --manifest-path crates/Cargo.toml shell`
Expected: 编译失败（`execute_argv` 未定义）

- [ ] **Step 1.3: 重构 shell.rs**

`execute()` 保留（Noop 路径），主体抽出共享内核；新增 `execute_argv`：

```rust
pub fn execute(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    let mut cmd = build_command(command);
    run_command(&mut cmd, cwd, timeout_ms, on_spawn)
}

/// argv 执行路径：包装型 provider（Seatbelt/bwrap）的 launcher argv 直接 spawn，
/// 不经过 `sh -c` 二次拼接（profile 塞字符串的转义不可维护）。
/// `envs` 在继承父环境之上叠加覆盖（如 TMPDIR 重定向）。
pub fn execute_argv(
    argv: &[String],
    envs: &[(&str, String)],
    cwd: &std::path::Path,
    timeout_ms: u64,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    let first = argv.first().ok_or_else(|| "argv is empty".to_string())?;
    let mut cmd = Command::new(first);
    cmd.args(&argv[1..]);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    run_command(&mut cmd, cwd, timeout_ms, on_spawn)
}

fn run_command(
    cmd: &mut Command,
    cwd: &std::path::Path,
    timeout_ms: u64,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    // 原 execute() 的 31-85 行整体挪入：timeout_ms 钳制、cwd 校验、stdin/pipes、
    // #[cfg(unix)] process_group(0)、spawn、drain_pipe×2、轮询+kill_tree、join、组装。
    // 行为逐行保持，禁止顺手改动。
}
```

- [ ] **Step 1.4: trait wrap 签名改造**

`sandbox/mod.rs`：

```rust
    /// 包装路径（轮次 B）：返回完整 argv（launcher + `-- sh -c <command>`）。
    /// None = 不包装（Noop 现状路径）。请求上下文经 `SandboxRequest` 进入渲染。
    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        let _ = request;
        None
    }
```

- 文件头注释同步（删除"未来 Seatbelt、bwrap"字样 → 已有三平台）。
- `SandboxRequest` 的 `#[allow(dead_code)]` 注释改为
  `// allow_network/writable_roots 由平台 provider 渲染消费（部分平台构建下未用）`，
  保留 `#[allow(dead_code)]`（Windows-only 构建下这两个字段仍无人读）。
- 更新既有工厂测试（macOS 上 provider 可能不再是 none）：

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn factory_never_reports_unavailable_provider() {
        let provider = provider();
        assert!(
            provider.is_available() || provider.id() == "none",
            "non-noop provider must have passed its probe"
        );
    }

    #[test]
    fn noop_wrap_defers_to_plain_execution() {
        let request = SandboxRequest {
            command: "echo hi".to_string(),
            cwd: std::env::temp_dir(),
            timeout_ms: 1_000,
            allow_network: false,
            writable_roots: vec![],
        };
        assert!(NoopSandbox.wrap(&request).is_none());
    }
}
```

- [ ] **Step 1.5: handler 分发更新**

`handlers.rs` `handle_shell_execute` 线程内，替换 `None => shell::execute(...)` 臂：

```rust
            None => match provider.wrap(&request) {
                Some(argv) => {
                    // 包装路径：TMPDIR 指到沙盒临时目录（与 Windows 轮 TMP/TEMP 重定向
                    // 同语义；该目录已在 request.writable_roots 白名单里）。
                    // 线程闭包非 Result 上下文，禁止 `?`——用 match 产出 Err 走统一上报。
                    let temp = sandbox::sandbox_temp_dir();
                    match std::fs::create_dir_all(&temp) {
                        Ok(()) => shell::execute_argv(
                            &argv,
                            &[("TMPDIR", temp.display().to_string())],
                            &request.cwd,
                            request.timeout_ms,
                            &|pid| {
                                let _ = running_shells().lock().map(|mut shells| {
                                    shells.insert(request_id.clone(), pid);
                                });
                            },
                        ),
                        Err(error) => {
                            Err(format!("sandbox temp dir create failed: {error}"))
                        }
                    }
                }
                None => shell::execute(
                    &request.command,
                    &request.cwd,
                    request.timeout_ms,
                    &|pid| {
                        let _ = running_shells().lock().map(|mut shells| {
                            shells.insert(request_id.clone(), pid);
                        });
                    },
                ),
            },
```

`outcome` 类型不变（`Result<ShellOutcome, String>`），`Err(message)` 走既有
`execution_failed` 上报分支。

- [ ] **Step 1.6: 全量测试 + 双 target 门**

```bash
source ~/.cargo/env
cargo test --manifest-path crates/Cargo.toml
cargo fmt --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: 全绿（含既有 75+2；Noop 路径回归 = 既有 shell/handlers 测试不动点）。

- [ ] **Step 1.7: Commit**

```bash
git add crates/system-runtime/src/
git commit -m "refactor(runtime): sandbox wrap 改 argv 形态 + shell::execute_argv 内核抽取"
```

---

### Task 2: macOS Seatbelt provider（渲染器 + 探测 + 单测）

**Files:**

- Create: `crates/system-runtime/src/sandbox/macos.rs`
- Modify: `crates/system-runtime/src/sandbox/mod.rs`（mod 声明，**不带 cfg 门**）

- [ ] **Step 2.1: mod.rs 挂模块**

```rust
// Seatbelt/bwrap 渲染器全平台编译（纯字符串/std::process），便于跨机单测；
// select() 仅在对应平台 cfg 分支消费。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) mod macos;
```

- [ ] **Step 2.2: 实现 macos.rs**

```rust
//! macOS Seatbelt provider：`sandbox-exec -p <profile>` 包装（deny-default 白名单）。
//! 语义参照 codex macOS 沙箱：读大体放开（保可用性）+ 敏感凭据路径拒读；
//! 写只放可写根；网络仅在审批放行（allow_network）时打开。
//! `sandbox-exec` 是 exec 语义（替换自身），包装后 pid 即 `sh` 的 pid，
//! 现有 `kill(-pgid)` 进程组树杀语义不变。

use std::path::{Path, PathBuf};

use super::{SandboxProvider, SandboxRequest};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Clone)]
pub(crate) struct SeatbeltSandbox {
    home: Option<PathBuf>,
    data_dir: PathBuf,
}

impl SeatbeltSandbox {
    pub(crate) fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // 与 runtime 存储同一规则：REFLEXION_DATA_DIR 优先，缺省 ~/.reflexion-os-studio。
        let data_dir = std::env::var_os("REFLEXION_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.clone().unwrap_or_default().join(".reflexion-os-studio"));
        Self { home, data_dir }
    }

    /// 探测：二进制存在 + 最小 profile 干跑成功（未来 macOS 移除 sandbox-exec 时如实降级）。
    pub(crate) fn probe() -> bool {
        if !Path::new(SANDBOX_EXEC).exists() {
            return false;
        }
        std::process::Command::new(SANDBOX_EXEC)
            .args(["-p", "(version 1)(allow default)", "--", "/usr/bin/true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(crate) fn build_argv(&self, request: &SandboxRequest) -> Vec<String> {
        let profile = render_profile(request, self.home.as_deref(), &self.data_dir);
        vec![
            SANDBOX_EXEC.to_string(),
            "-p".to_string(),
            profile,
            "--".to_string(),
            "/bin/sh".to_string(),
            "-c".to_string(),
            request.command.clone(),
        ]
    }
}

impl SandboxProvider for SeatbeltSandbox {
    fn id(&self) -> &'static str {
        "seatbelt"
    }

    fn is_available(&self) -> bool {
        Self::probe()
    }

    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        Some(self.build_argv(request))
    }
}

fn denied_read_paths(home: Option<&Path>, data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data_dir.to_path_buf()];
    if let Some(home) = home {
        for tail in [".ssh", ".aws", ".gnupg"] {
            paths.push(home.join(tail));
        }
    }
    paths
}

/// 纯函数渲染，单测钉住核心结构；真机白名单微调以集成测试为准（禁软化核心语义）。
pub(crate) fn render_profile(
    request: &SandboxRequest,
    home: Option<&Path>,
    data_dir: &Path,
) -> String {
    let mut profile = String::from(
        "(version 1)\n\
         (deny default)\n\
         (allow process*)\n\
         (allow process-info*)\n\
         (allow signal (target same-sandbox))\n\
         (allow file-read*)\n",
    );
    let denied = denied_read_paths(home, data_dir);
    profile.push_str("(deny file-read*");
    for path in &denied {
        profile.push_str(&format!(" (subpath {})", sbpl_string(path)));
    }
    profile.push_str(")\n");
    for root in &request.writable_roots {
        profile.push_str(&format!(
            "(allow file-write* (subpath {}))\n",
            sbpl_string(root)
        ));
    }
    profile.push_str(
        "(allow file-write-data\n\
         \x20(literal \"/dev/null\") (literal \"/dev/dtracehelper\") (subpath \"/dev/tt\"))\n\
         (allow file-ioctl (literal \"/dev/null\") (subpath \"/dev/tt\"))\n\
         (allow sysctl-read)\n\
         (allow ipc-posix-shm)\n\
         (allow mach-lookup)\n\
         (allow iokit-open)\n",
    );
    if request.allow_network {
        profile.push_str("(allow network*)\n");
    }
    profile
}

/// SBPL 字符串字面量转义（路径可能含空格/引号）。
fn sbpl_string(path: &Path) -> String {
    let mut out = String::from('"');
    for ch in path.to_string_lossy().chars() {
        match ch {
            '"' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            control if (control as u32) < 0x20 => out.push_str(&format!("\\{:03o}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(roots: &[&str], allow_network: bool) -> SandboxRequest {
        SandboxRequest {
            command: "echo hi".to_string(),
            cwd: PathBuf::from("/w"),
            timeout_ms: 1000,
            allow_network,
            writable_roots: roots.iter().map(PathBuf::from).collect(),
        }
    }

    #[test]
    fn profile_is_deny_default_with_scoped_allows() {
        let profile = render_profile(
            &request(&["/w", "/tmp/reflexion-sandbox"], false),
            Some(Path::new("/Users/tester")),
            Path::new("/Users/tester/.reflexion-os-studio"),
        );
        assert!(profile.starts_with("(version 1)\n(deny default)"));
        assert!(profile.contains("(allow file-write* (subpath \"/w\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/tmp/reflexion-sandbox\"))"));
        assert!(profile.contains("(subpath \"/Users/tester/.ssh\")"));
        assert!(profile.contains("(subpath \"/Users/tester/.reflexion-os-studio\")"));
        assert!(
            !profile.contains("(allow network"),
            "no network allowance without approval: {profile}"
        );
    }

    #[test]
    fn profile_opens_network_only_when_approved() {
        let profile = render_profile(&request(&["/w"], true), None, Path::new("/d"));
        assert!(profile.contains("(allow network*)"));
    }

    #[test]
    fn sbpl_string_escapes_quotes_backslashes_and_control() {
        let weird = PathBuf::from("/tmp/he said \"hi\"\\done\u{1}x");
        let rendered = sbpl_string(&weird);
        assert!(rendered.starts_with('"') && rendered.ends_with('"'));
        assert!(rendered.contains("\\\"hi\\\""));
        assert!(rendered.contains("\\\\done"));
        assert!(rendered.contains("\\001x"));
    }

    #[test]
    fn build_argv_is_sandbox_exec_prefix_plus_sh() {
        let sandbox = SeatbeltSandbox::from_env();
        let argv = sandbox.build_argv(&request(&["/w"], false));
        assert_eq!(argv[0], "/usr/bin/sandbox-exec");
        assert_eq!(argv[1], "-p");
        assert_eq!(argv[3], "--");
        assert_eq!(argv[4], "/bin/sh");
        assert_eq!(argv[5], "-c");
        assert_eq!(argv[6], "echo hi");
    }
}
```

- [ ] **Step 2.3: 测试 + 三门 + Commit**

```bash
cargo test --manifest-path crates/Cargo.toml sandbox
cargo fmt --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
git add crates/system-runtime/src/sandbox/
git commit -m "feat(runtime): macOS Seatbelt profile 渲染与 sandbox-exec provider"
```

---

### Task 3: macOS 工厂接线 + 真机集成测试（白名单迭代）

**Files:**

- Modify: `crates/system-runtime/src/sandbox/mod.rs`（select 分支）
- Modify: `crates/system-runtime/src/sandbox/macos.rs`（追加集成测试；按失败迭代 profile）

- [ ] **Step 3.1: select() 挂 macOS 分支**

```rust
fn select() -> Box<dyn SandboxProvider> {
    #[cfg(windows)]
    {
        let provider = windows::WindowsTokenSandbox;
        if provider.is_available() {
            return Box::new(provider);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let provider = macos::SeatbeltSandbox::from_env();
        if provider.is_available() {
            return Box::new(provider);
        }
    }
    Box::new(NoopSandbox)
}
```

- [ ] **Step 3.2: 真机集成测试（`#[cfg(all(test, target_os = "macos"))]`，写在 macos.rs）**

结构约定：直接构造 `SeatbeltSandbox { home: Some(fake_home), data_dir: fake_data }`
（测试私有实例，不碰全局工厂），`build_argv` + `shell::execute_argv`（带
`TMPDIR=<sandbox_temp>` env，sandbox_temp 用测试临时目录模拟 handler 行为）执行真实命令。

必须覆盖的断言（acceptance 合同，来自 spec §11.3）：

```rust
// 1) echo 正常（可用性）；stdout 捕获、exit 0。
// 2) 越界写被拒：touch <fake_home>/escape.txt → exit 非 0 且文件不存在。
// 3) 可写根内成功：touch <workspace>/inside.txt → exit 0 且文件存在；
//    TMPDIR（列入 writable_roots）内写成功。
// 4) 拒读：fake_data/secrets.json 放哨兵内容，cat → 非 0；
//    普通 HOME 文件（fake_home/plain.txt）仍可读（读大体放开的策略钉住）。
// 5) 禁网（不依赖外网）：curl -sS -m 8 http://127.0.0.1:9
//    → 非 0 且 stderr 含 "Operation not permitted"（connect 被 seatbelt 拒，而非 ECONNREFUSED）。
// 6) allow_network=true 同命令 → stderr 不含 "Operation not permitted"
//    （走到 refused，说明 socket 可用）。
// 7) 超时：sleep 30 / 500ms → timed_out true，kill_tree 语义沿用（sh 被 exec 替换，pgid 直达）。
```

- [ ] **Step 3.3: 常用工具回归（白名单迭代入口）**

同一测试模块内加"常见命令不被误杀"用例（真实执行、断言 exit 0）：

```text
git --version
node -v            （存在则跑；which 探测后条件断言，避免环境差异假红）
python3 -c 'print(1)'
ls /
```

以及 `git status` 在一个 `git init` 出来的临时 workspace 内成功（写 `.git` 属可写根）。

- [ ] **Step 3.4: 迭代 profile 直到 3.2/3.3 全绿**

真机失败信息（`sandbox-exec: deny(1) file-write-data ...` 之类）→ 按最小放行原则补
class/subpath；**禁止**用 `(allow default)`、删 deny、或全局 allow network 来"过测试"。
迭代记录（每条新增规则 + 理由）写进 `render_profile` 的 doc 注释。

- [ ] **Step 3.5: 全量门 + Commit**

```bash
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
git add crates/system-runtime/src/sandbox/
git commit -m "feat(runtime): macOS 工厂接线 + Seatbelt 真机验收测试（写边界/拒读/禁网）"
```

---

### Task 4: Linux bwrap provider（渲染器单测 + 编译门，运行时未验证如实标注）

**Files:**

- Create: `crates/system-runtime/src/sandbox/linux.rs`
- Modify: `crates/system-runtime/src/sandbox/mod.rs`（mod 声明 + select 分支）

- [ ] **Step 4.1: linux.rs 实现**

```rust
//! Linux bwrap provider：bubblewrap 命名空间沙箱。
//! 网络：--unshare-all 自带 netns（未批网 → OS 级禁网，审批后 --share-net）。
//! 写：--ro-bind / / 全局只读 + --bind 可写根；敏感路径 --tmpfs 遮蔽（呈现为空目录）。
//! 取消兜底：--new-session 会脱离外层进程组信号，依赖 --die-with-parent 收割
//! （bwrap 死 → 沙箱内 init 收 SIGHUP/SIGKILL）。差异已记入 spec §12.1。
//! 本模块全平台编译（纯 args 渲染 + 干跑探测）；Linux 运行时行为在开发机未验证。

use std::path::{Path, PathBuf};

use super::{SandboxProvider, SandboxRequest};

const FIXED_TMP: &str = "/tmp/reflexion-sandbox";

#[derive(Clone)]
pub(crate) struct BwrapSandbox {
    home: Option<PathBuf>,
    data_dir: PathBuf,
}

impl BwrapSandbox {
    pub(crate) fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let data_dir = std::env::var_os("REFLEXION_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.clone().unwrap_or_default().join(".reflexion-os-studio"));
        Self { home, data_dir }
    }

    /// 探测：bwrap 可用 + userns/netns 干跑成功（硬化内核禁非特权 userns 时降级 none）。
    pub(crate) fn probe() -> bool {
        std::process::Command::new("bwrap")
            .args(["--version"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
            && std::process::Command::new("bwrap")
                .args(["--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
    }
}

impl SandboxProvider for BwrapSandbox {
    fn id(&self) -> &'static str {
        "bwrap"
    }

    fn is_available(&self) -> bool {
        Self::probe()
    }

    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        Some(build_bwrap_args(request, self.home.as_deref(), &self.data_dir))
    }
}

/// 纯函数渲染（单测金样钉住；开发机不执行 bwrap）。
pub(crate) fn build_bwrap_args(
    request: &SandboxRequest,
    home: Option<&Path>,
    data_dir: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "bwrap".into(),
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
    ];
    // 可写根（handler 约定：[workspace_root, sandbox_temp]）。沙盒临时目录双挂载：
    // 原路径 + 固定名（TMPDIR 覆盖值；handler 在 host 侧已建好该目录）。
    for root in &request.writable_roots {
        let text = root.to_string_lossy().into_owned();
        args.extend(["--bind".into(), text.clone(), text]);
    }
    if let Some(temp) = request.writable_roots.last() {
        args.extend([
            "--bind".into(),
            temp.to_string_lossy().into_owned(),
            FIXED_TMP.into(),
        ]);
    }
    // 敏感路径遮蔽为空 tmpfs（读不到内容即达标）。
    let mut masked: Vec<PathBuf> = vec![data_dir.to_path_buf()];
    if let Some(home) = home {
        for tail in [".ssh", ".aws", ".gnupg"] {
            masked.push(home.join(tail));
        }
    }
    for path in masked {
        args.extend(["--tmpfs".into(), path.to_string_lossy().into_owned()]);
    }
    args.extend(["--tmpfs".into(), "/dev/shm".into()]);
    // 网络：OS 级禁断是 Linux 档强项；仅审批通过后共享。
    args.push("--unshare-all".into());
    if request.allow_network {
        args.push("--share-net".into());
    }
    args.extend([
        "--die-with-parent".into(),
        "--new-session".into(),
        "--setenv".into(),
        "TMPDIR".into(),
        FIXED_TMP.into(),
        "--".into(),
        "/bin/sh".into(),
        "-c".into(),
        request.command.clone(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(allow_network: bool) -> SandboxRequest {
        SandboxRequest {
            command: "echo hi".to_string(),
            cwd: PathBuf::from("/w"),
            timeout_ms: 1000,
            allow_network,
            writable_roots: vec![PathBuf::from("/w"), PathBuf::from("/tmp-x/reflexion-sandbox")],
        }
    }

    fn joined(allow_network: bool) -> String {
        build_bwrap_args(&request(allow_network), Some(Path::new("/home/t")), Path::new("/data"))
            .join("\u{1}")
    }

    #[test]
    fn root_is_read_only_with_scoped_writable_binds() {
        let args = joined(false);
        assert!(args.contains(&format!("--ro-bind\u{1}/\u{1}/\u{1}/")));
        assert!(args.contains("--bind\u{1}/w\u{1}/w"));
        assert!(args.contains("--bind\u{1}/tmp-x/reflexion-sandbox\u{1}/tmp-x/reflexion-sandbox"));
        assert!(args.contains(&format!("--bind\u{1}/tmp-x/reflexion-sandbox\u{1}{FIXED_TMP}")));
    }

    #[test]
    fn sensitive_paths_are_masked() {
        let args = joined(false);
        for masked in ["/home/t/.ssh", "/home/t/.aws", "/home/t/.gnupg", "/data"] {
            assert!(
                args.contains(&format!("--tmpfs\u{1}{masked}")),
                "missing mask for {masked}"
            );
        }
    }

    #[test]
    fn network_shared_only_after_approval() {
        assert!(joined(false).contains("--unshare-all"));
        assert!(!joined(false).contains("--share-net"));
        assert!(joined(true).contains("--share-net"));
    }

    #[test]
    fn terminates_with_sh_command_and_safety_flags() {
        let args = build_bwrap_args(&request(false), None, Path::new("/d"));
        assert!(args.contains("--die-with-parent"));
        assert!(args.contains("--new-session"));
        assert!(args.contains(&format!("--setenv\u{1}TMPDIR\u{1}{FIXED_TMP}")));
        assert_eq!(&args[args.len() - 4..], ["--", "/bin/sh", "-c", "echo hi"].map(String::from).as_slice());
        // HOME 缺失时不渲染家目录遮蔽（无 /None 之类病态路径）。
        assert!(!args.join(" ").contains("/None"));
    }
}
```

- [ ] **Step 4.2: mod.rs 接线**

```rust
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) mod linux;
```

select() 追加（windows 分支之后）：

```rust
    #[cfg(target_os = "linux")]
    {
        let provider = linux::BwrapSandbox::from_env();
        if provider.is_available() {
            return Box::new(provider);
        }
    }
```

- [ ] **Step 4.3: 三 target 门 + Commit**

```bash
cargo test --manifest-path crates/Cargo.toml sandbox
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
rustup target add x86_64-unknown-linux-gnu 2>/dev/null || true
cargo check --manifest-path crates/Cargo.toml --target x86_64-unknown-linux-gnu
git add crates/system-runtime/src/sandbox/
git commit -m "feat(runtime): Linux bwrap provider（args 渲染+探测，Linux 编译门）"
```

注：`cargo check --target x86_64-unknown-linux-gnu` 在 macOS 上可编译检查（无链接步骤）；
若 libc/std 的 Linux 目标产物缺失导致 check 不可行，**如实报告并以 host build 为准**
（本模块无平台 API，风险极低），不得静默跳过。

---

### Task 5: TS 措辞、文档与全链验证

**Files:**

- Modify: `apps/runtime/src/agent/tools/shell.ts`（description 一句）
- Modify: `docs/SHELL-SANDBOX-PLAN.md`、`docs/PERMISSION-MODEL.md`、`AGENTS.md`

- [ ] **Step 5.1: shell.ts description 升级**

把"未声明时未来 OS 沙箱内必失败"改为（保持单引号 prettier 风格）：

```
沙箱默认禁网：命令需要联网（npm install / git push / curl 等）时必须将 requires_network 置 true 并等待用户批准；未声明的联网尝试在 macOS/Linux 沙箱内会被 OS 直接拒绝（Windows 为流程闸门）。
```

`pnpm --filter @reflexion-os-studio/runtime build` 后跑 runtime 测试确认无断言依赖旧文案。

- [ ] **Step 5.2: 文档更新**

- `docs/SHELL-SANDBOX-PLAN.md`：§2 非目标移除 Seatbelt/bwrap；§5 表更新 S2/S4 行为
  "轮次 B 已实施"，新增 B1/B2/B3 行：
  | B1 | trait argv 化 + execute_argv | 既有测试全绿 + Windows 交叉编译保持绿 |
  | B2 | macOS Seatbelt | 真机验收：越界写被拒/敏感拒读/禁网（curl 本机 127.0.0.1 合同）/常见命令不误杀 |
  | B3 | Linux bwrap | 渲染器单测金样 + Linux target 编译门；真机验收挂起（无 Linux 环境）：
  写边界/禁网/userns 降级/bwrap 缺失降级 |
- §4.4 矩阵指向 spec（三平台版已在 spec）；
- `AGENTS.md` §1 沙箱行改为：三平台 provider（Windows 受限令牌/macOS Seatbelt/Linux bwrap）+
  网络审批闭环（macOS/Linux 为 OS 强制+流程双保险）+ Noop 降级；
- `docs/PERMISSION-MODEL.md` L77 行同步"macOS/Linux/Windows 三平台档已落地
  （Linux/Windows 运行时验证状态按 spec 如实标注）"。

- [ ] **Step 5.3: 全链验证（AGENTS.md §6 顺序）**

```bash
source ~/.cargo/env
pnpm format:check && pnpm lint && pnpm typecheck
pnpm --filter @reflexion-os-studio/desktop typecheck
pnpm build:packages
cargo fmt --manifest-path crates/Cargo.toml -- --check
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: 全部通过（真机 Seatbelt 测试已含在 cargo test 内）。

- [ ] **Step 5.4: 冒烟（打包无关，dev 语义抽查）**

用 sidecar 冒烟模式验证 ready 能力位：

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"system.ping"}' \
  '{"jsonrpc":"2.0","id":2,"method":"system.shutdown"}' \
  | ./crates/target/debug/reflexion-system-runtime 2>/dev/null | head -1
```

Expected: `system.ready` 的 `params.sandbox == "seatbelt"`（macOS 真机）。

- [ ] **Step 5.5: Commit**

```bash
git add apps/runtime/src/agent/tools/shell.ts docs/ AGENTS.md
git commit -m "docs+polish: 轮次 B 三平台沙箱落地口径（措辞/验收表/能力清单）"
```

---

## 完成标准（全部满足才可宣告）

1. macOS：cargo test 全绿**含真机 Seatbelt 集成测试**（写边界/拒读/禁网/超时/常见命令回归）。
2. Linux：渲染器金样测试全绿 + `x86_64-unknown-linux-gnu` 编译门通过（或如实报告不可行原因）。
3. Windows：`x86_64-pc-windows-msvc` 编译门保持绿；`exec_direct` 行为零改动（既有测试钉住）。
4. Noop 语义：探测失败才降级；`system.ready` 在 macOS 真机报 `seatbelt`。
5. AGENTS.md §6 全链通过；文档三处更新与真实状态一致，不夸大 Linux 验证覆盖。
