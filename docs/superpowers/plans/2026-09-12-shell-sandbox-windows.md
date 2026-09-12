# Shell 沙箱骨架 + Windows 受限令牌 + 网络审批闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `SandboxProvider` 双路径 trait + 工厂，实现 Windows 受限令牌沙箱（codex unelevated 同族）与按命令网络审批闭环（S3）。

**Architecture:** Rust 侧 `crates/system-runtime/src/sandbox/`（trait + Noop + cfg(windows) 三子模块），`handle_shell_execute` 经工厂分发；TS 侧工具参数/审批网关/grant 签发增量；协议三处向后兼容扩展。spec：`docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md`。

**Tech Stack:** Rust（官方 `windows` crate，仅 Windows target）、Node `node:test`（测 `dist/` 导出）。

**验证边界（必须如实执行与汇报）:**
- 本机 macOS：`cargo test` 全绿 + 全链验证；Windows 仅 `cargo check --target x86_64-pc-windows-msvc` **编译级验证，运行时行为未经真机验证**。
- Windows FFI 的模块路径/签名以 `cargo check --target x86_64-pc-windows-msvc` 的编译反馈修正为准——该命令就是 Task 3–5 的"运行测试"步骤，修正仅限 API 形状（模块路径、参数包装类型、BOOL/newtype 转换），不得改变语义。
- 依赖版本号（`windows = "0.62"`）如与编译反馈冲突，按 cargo 提示的可用版本修正并保持 feature 列表完整。

---

### Task 1: Rust 沙箱骨架（trait + Noop + 工厂）

**Files:**
- Create: `crates/system-runtime/src/sandbox/mod.rs`
- Create: `crates/system-runtime/src/sandbox/noop.rs`
- Modify: `crates/system-runtime/src/main.rs:10-23`（mod 声明区）

- [ ] **Step 1.1: 写失败测试（先于实现，编译失败即"测试失败"）**

创建 `crates/system-runtime/src/sandbox/mod.rs`，先只含测试骨架：

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn factory_falls_back_to_noop_on_unix_this_round() {
        assert_eq!(provider().id(), "none");
    }

    #[test]
    fn noop_wrap_is_identity() {
        assert_eq!(provider().wrap("echo hi".to_string()), "echo hi".to_string());
    }
}
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cargo test --manifest-path crates/Cargo.toml sandbox`
Expected: 编译失败（`provider`、`SandboxProvider` 未定义）

- [ ] **Step 1.3: 实现骨架**

将 `crates/system-runtime/src/sandbox/mod.rs` 补全为：

```rust
//! Shell 沙箱抽象：平台 provider 工厂（Noop 降级 / Windows 受限令牌 / 未来 Seatbelt、bwrap）。
//! 设计：docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md。
//! 双路径 trait：包装型 provider（Seatbelt/bwrap）实现 wrap；自持执行型（Windows）
//! 实现 exec_direct。工厂进程内选定一次，选定后执行失败 fail-closed，不回退无沙箱。

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::shell::ShellOutcome;

#[cfg(windows)]
pub(crate) mod windows;
pub(crate) mod noop;

pub use noop::NoopSandbox;

/// 一次 shell 执行的沙箱请求（handlers 组装，provider 消费）。
pub(crate) struct SandboxRequest {
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_ms: u64,
    pub allow_network: bool,
    /// 可写边界（Windows：打 LOW 完整性标签；macOS 下轮进 Seatbelt profile）。
    /// 顺序约定：[workspace_root, sandbox_temp_dir]。
    pub writable_roots: Vec<PathBuf>,
}

pub(crate) trait SandboxProvider: Send + Sync {
    /// 稳定标识，进入协议："windows-token" / "none"（未来追加 "seatbelt" / "bwrap"）。
    fn id(&self) -> &'static str;

    /// 工厂探测：不可用则降级 Noop。仅在工厂初始化时调用一次。
    fn is_available(&self) -> bool;

    /// 自持执行路径（Windows CreateProcessAsUserW）。返回 None = 走包装路径。
    fn exec_direct(
        &self,
        request: &SandboxRequest,
        on_spawn: &dyn Fn(u32),
    ) -> Option<Result<ShellOutcome, String>> {
        let _ = (request, on_spawn);
        None
    }

    /// 包装路径：改写命令字符串（Seatbelt 下轮：`sandbox-exec -p <profile> -- …`）。
    /// 默认恒等（Noop / 未实现包装的平台）。
    fn wrap(&self, command: String) -> String {
        command
    }
}

/// 进程内唯一 provider：Windows 探测受限令牌，其余平台本轮 Noop（Seatbelt 下轮接入）。
pub(crate) fn provider() -> &'static dyn SandboxProvider {
    static PROVIDER: OnceLock<Box<dyn SandboxProvider>> = OnceLock::new();
    PROVIDER.get_or_init(select).as_ref()
}

fn select() -> Box<dyn SandboxProvider> {
    #[cfg(windows)]
    {
        let candidate = windows::WindowsTokenSandbox;
        if candidate.is_available() {
            return Box::new(candidate);
        }
    }
    Box::new(NoopSandbox)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn factory_falls_back_to_noop_on_unix_this_round() {
        assert_eq!(provider().id(), "none");
    }

    #[test]
    fn noop_wrap_is_identity() {
        assert_eq!(provider().wrap("echo hi".to_string()), "echo hi".to_string());
    }
}
```

创建 `crates/system-runtime/src/sandbox/noop.rs`：

```rust
//! Noop provider：无 OS 沙箱时的降级终点（保持现状执行路径与语义）。

use super::SandboxProvider;

pub(crate) struct NoopSandbox;

impl SandboxProvider for NoopSandbox {
    fn id(&self) -> &'static str {
        "none"
    }

    fn is_available(&self) -> bool {
        true
    }
}
```

`crates/system-runtime/src/main.rs` 的 mod 声明区（`mod shell;` 之后）加入：

```rust
mod sandbox;
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `cargo test --manifest-path crates/Cargo.toml sandbox`
Expected: 2 passed

- [ ] **Step 1.5: Commit**

```bash
git add crates/system-runtime/src/sandbox/ crates/system-runtime/src/main.rs
git commit -m "feat(runtime): SandboxProvider 双路径 trait + 工厂 + Noop 降级"
```

---

### Task 2: Windows 依赖接入（编译门）

**Files:**
- Modify: `crates/system-runtime/Cargo.toml`

- [ ] **Step 2.1: 添加 Windows target 依赖**

`crates/system-runtime/Cargo.toml` 末尾（`[target.'cfg(unix)'.dependencies]` 段之后）追加：

```toml
[target.'cfg(windows)'.dependencies]
# Windows 受限令牌沙箱（codex unelevated 同族）：仅 Windows target 编译。
windows = { version = "0.62", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_Security_Authorization",
  "Win32_Storage_FileSystem",
  "Win32_System_JobObjects",
  "Win32_System_Pipes",
  "Win32_System_Threading",
] }
```

- [ ] **Step 2.2: 双 target 编译验证（macOS 不受影响 + Windows 可解析依赖）**

```bash
source ~/.cargo/env
cargo check --manifest-path crates/Cargo.toml
rustup target add x86_64-pc-windows-msvc
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: 两条 check 均成功（Windows crate 拉取依赖；本任务无 cfg(windows) 代码，仅验证依赖可用）

- [ ] **Step 2.3: Commit**

```bash
git add crates/system-runtime/Cargo.toml crates/system-runtime/Cargo.lock
git commit -m "build(runtime): 接入 windows crate（仅 Windows target）"
```

---

### Task 3: Windows 受限令牌（token.rs）

**Files:**
- Create: `crates/system-runtime/src/sandbox/windows/mod.rs`（占位）
- Create: `crates/system-runtime/src/sandbox/windows/token.rs`

> 本任务起，Windows 代码的验证方式是编译门（见验证边界）。FFI 模块路径/签名如与
> windows crate 实际版本不符，按编译错误逐条修正 API 形状，保持语义不变。

- [ ] **Step 3.1: 实现 provider 占位与 token 模块**

`crates/system-runtime/src/sandbox/windows/mod.rs`（Task 5 会补全 provider）：

```rust
//! Windows 受限令牌沙箱 provider（codex unelevated 同族）。

pub(crate) mod token;
```

创建 `crates/system-runtime/src/sandbox/windows/token.rs`：

```rust
//! Windows 受限令牌：剥离全部特权（DISABLE_MAX_PRIVILEGE）+ 禁用 Administrators SID
//! + 低完整性级别（LOW, S-1-16-4096）。语义参照 codex unelevated 档。
//! 令牌进程内缓存：工厂探测时创建，之后所有沙箱执行复用同一句柄。

use std::sync::OnceLock;

use windows::core::{w, Result};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::{
    ConvertStringSidToSidW, CreateRestrictedToken, CreateWellKnownSid, SetTokenInformation,
    DISABLE_MAX_PRIVILEGE, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel, WinBuiltinAdministratorsSid,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

static RESTRICTED_TOKEN: OnceLock<Option<HANDLE>> = OnceLock::new();

/// 工厂探测：成功创建受限令牌即视为可用；结果缓存，执行复用同一令牌。
pub(crate) fn probe() -> bool {
    restricted_token().is_some()
}

/// 受限令牌句柄（缓存）。None = 创建失败（此时 exec_direct 必须报错而非回退）。
pub(crate) fn restricted_token() -> Option<HANDLE> {
    *RESTRICTED_TOKEN.get_or_init(|| create_restricted_token().ok())
}

fn create_restricted_token() -> Result<HANDLE> {
    unsafe {
        let mut base = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY,
            &mut base,
        )?;

        // 禁用 Administrators SID（SECURITY_MAX_SID_SIZE = 68）。
        let mut admin_sid_buf = [0u8; 68];
        let mut sid_size = admin_sid_buf.len() as u32;
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            None,
            Some(admin_sid_buf.as_mut_ptr().cast()),
            &mut sid_size,
        )?;
        let admin = SID_AND_ATTRIBUTES {
            Sid: admin_sid_buf.as_ptr().cast(),
            Attributes: 0,
        };

        // DISABLE_MAX_PRIVILEGE：剥离全部特权。
        let mut restricted = HANDLE::default();
        CreateRestrictedToken(
            base,
            DISABLE_MAX_PRIVILEGE,
            1,
            Some(&admin),
            0,
            None,
            0,
            None,
            &mut restricted,
        )?;

        set_low_integrity(restricted)?;
        Ok(restricted)
    }
}

fn set_low_integrity(token: HANDLE) -> Result<()> {
    unsafe {
        let mut sid_ptr = std::ptr::null_mut();
        ConvertStringSidToSidW(w!("S-1-16-4096"), &mut sid_ptr)?;
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: sid_ptr.cast(),
                Attributes: 0,
            },
        };
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(&label as *const _ as *const core::ffi::c_void),
            std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
        )
    }
}
```

- [ ] **Step 3.2: 编译门（双 target）**

```bash
cargo check --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: 均成功；Windows 侧如报 API 路径/签名错误，按提示修正至通过

- [ ] **Step 3.3: Commit**

```bash
git add crates/system-runtime/src/sandbox/windows/
git commit -m "feat(runtime): Windows 受限令牌构造（剥离特权+禁管理员 SID+低完整性）"
```

---

### Task 4: Windows 文件写边界（acl.rs）

**Files:**
- Create: `crates/system-runtime/src/sandbox/windows/acl.rs`
- Modify: `crates/system-runtime/src/sandbox/windows/mod.rs`（加 mod 声明）

- [ ] **Step 4.1: 实现 acl 模块**

`crates/system-runtime/src/sandbox/windows/mod.rs` 的 mod 区改为：

```rust
//! Windows 受限令牌沙箱 provider（codex unelevated 同族）。

pub(crate) mod acl;
pub(crate) mod token;
```

创建 `crates/system-runtime/src/sandbox/windows/acl.rs`：

```rust
//! Windows 文件写边界：对可写 root（workspace root、沙盒临时目录）打 LOW 强制完整性
//! 标签（SACL "S:(ML;;OICI;;;LW)"，OI/CI 继承）。低完整性子进程只能写 LOW 标签目录。
//! 标签持久化在目录 ACL 上（幂等重设）；已处理 root 缓存，避免每命令重复设 ACL。
//! 注意：不给整个用户 TEMP 打标签（副作用过大），沙盒临时目录是专用子目录（见 launch.rs）。

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use windows::core::{w, PCWSTR};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
};
use windows::Win32::Security::{
    GetSecurityDescriptorSacl, ACL, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SE_FILE_OBJECT, SDDL_REVISION_1,
};

static LABELED_ROOTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 确保 path 具备 LOW 完整性标签；失败即 Err（调用方 fail-closed，不允许半沙箱）。
pub(crate) fn ensure_low_label(path: &Path) -> Result<(), String> {
    let key = path.to_string_lossy().into_owned();
    let mut guard = LABELED_ROOTS
        .lock()
        .map_err(|_| "low label cache poisoned".to_string())?;
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(&key) {
        return Ok(());
    }
    apply_low_label(path)
        .map_err(|error| format!("low integrity label failed for {key}: {error}"))?;
    set.insert(key);
    Ok(())
}

fn apply_low_label(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let mut object: Vec<u16> = path.as_os_str().encode_wide().collect();
    object.push(0);
    unsafe { set_label(object).map_err(|error| error.to_string()) }
}

unsafe fn set_label(mut object: Vec<u16>) -> windows::core::Result<()> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
        w!("S:(ML;;OICI;;;LW)"),
        SDDL_REVISION_1,
        &mut sd,
        None,
    )?;
    let mut present = false.into();
    let mut defaulted = false.into();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted)?;
    SetNamedSecurityInfoW(
        PCWSTR(object.as_mut_ptr()),
        SE_FILE_OBJECT,
        LABEL_SECURITY_INFORMATION,
        None,
        None,
        None,
        Some(sacl),
    )?;
    Ok(())
}
```

- [ ] **Step 4.2: 编译门（双 target）**

```bash
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
cargo check --manifest-path crates/Cargo.toml
```

Expected: 双 target 通过（windows crate 版本差异导致的 API 形状差异按编译反馈修正）

- [ ] **Step 4.3: Commit**

```bash
git add crates/system-runtime/src/sandbox/windows/
git commit -m "feat(runtime): Windows 可写 root 低完整性标签（写边界）"
```

---

### Task 5: Windows 执行器 + provider 接入工厂

**Files:**
- Create: `crates/system-runtime/src/sandbox/windows/launch.rs`
- Modify: `crates/system-runtime/src/sandbox/windows/mod.rs`（provider 实现）

- [ ] **Step 5.1: 实现执行器**

创建 `crates/system-runtime/src/sandbox/windows/launch.rs`：

```rust
//! Windows 沙箱执行器：CreateProcessAsUserW（受限令牌）+ 匿名管道 + Job Object。
//! 写边界：spawn 前对 writable_roots 打 LOW 完整性标签（失败 fail-closed）。
//! 临时目录：专用子目录 <TEMP>/reflexion-sandbox（打标签后经 TMP/TEMP 环境变量重定向，
//! 不给整个用户 TEMP 打标签）。输出上限/轮询节奏/超时语义与 shell.rs 对齐
//! （256KiB 截断、25ms 轮询、超时 TerminateJobObject 整树终止）。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::ReadFile;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, ResumeThread, SetHandleInformation,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, HANDLE_FLAG_INHERIT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

use super::acl;
use crate::sandbox::SandboxRequest;
use crate::shell::ShellOutcome;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL_MS: u32 = 25;
const SANDBOX_TEMP_DIR: &str = "reflexion-sandbox";

pub(crate) fn exec(
    request: &SandboxRequest,
    token: HANDLE,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    // 写边界先行：任一 root 打标签失败 → 整体失败（fail-closed，不启动进程）。
    for root in &request.writable_roots {
        acl::ensure_low_label(root)?;
    }
    let sandbox_temp = sandbox_temp_dir()?;
    acl::ensure_low_label(&sandbox_temp)?;

    unsafe {
        let (stdout_read, stdout_write) = inheritable_pipe()?;
        let (stderr_read, stderr_write) = inheritable_pipe()?;

        // 命令行引用规则与 std::process::Command 一致（含尾随反斜杠翻倍）。
        let mut cmdline: Vec<u16> = format!("cmd.exe /C {}", quote_arg(&request.command))
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut cwd: Vec<u16> = request
            .cwd
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let environment = environment_block(&sandbox_temp)?;

        let mut si = STARTUPINFOW::default();
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = stdout_write;
        si.hStdError = stderr_write;
        let mut pi = PROCESS_INFORMATION::default();
        CreateProcessAsUserW(
            token,
            None,
            PCWSTR(cmdline.as_mut_ptr()),
            None,
            None,
            true, // 管道写端可继承：必须 TRUE
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            Some(environment.as_ptr().cast()),
            PCWSTR(cwd.as_ptr()),
            &si,
            &mut pi,
        )
        .map_err(|error| format!("sandbox CreateProcessAsUserW failed: {error}"))?;

        // Job：KILL_ON_JOB_CLOSE 兜底收割；超时用 TerminateJobObject 整树终止。
        let job = CreateJobObjectW(None, None)
            .map_err(|error| format!("CreateJobObjectW failed: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|error| format!("SetInformationJobObject failed: {error}"))?;
        AssignProcessToJobObject(job, pi.hProcess)
            .map_err(|error| format!("AssignProcessToJobObject failed: {error}"))?;

        on_spawn(pi.dwProcessId);
        ResumeThread(pi.hThread);

        // 读端句柄由读取线程独占并负责关闭（避免双重 CloseHandle）。
        let stdout_handle = read_pipe_to_string(stdout_read);
        let stderr_handle = read_pipe_to_string(stderr_read);

        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let mut timed_out = false;
        loop {
            let wait = WaitForSingleObject(pi.hProcess, POLL_INTERVAL_MS);
            if wait == WAIT_OBJECT_0 {
                break;
            }
            if wait == WAIT_TIMEOUT && Instant::now() >= deadline
                || Instant::now() >= deadline
            {
                timed_out = true;
                let _ = TerminateJobObject(job, 1);
                WaitForSingleObject(pi.hProcess, u32::MAX);
                break;
            }
        }

        let mut exit_code: u32 = 0;
        GetExitCodeProcess(pi.hProcess, &mut exit_code)
            .map_err(|error| format!("GetExitCodeProcess failed: {error}"))?;
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
        // KILL_ON_JOB_CLOSE：job 句柄关闭时整树收割残留子进程。
        let _ = CloseHandle(job);

        let (stdout, stdout_truncated) = stdout_handle.join().unwrap_or_default();
        let (stderr, stderr_truncated) = stderr_handle.join().unwrap_or_default();
        Ok(ShellOutcome {
            exit_code: Some(exit_code as i32),
            stdout,
            stderr,
            timed_out,
            truncated: stdout_truncated || stderr_truncated,
        })
    }
}

/// 沙盒专用临时目录：<TEMP>/reflexion-sandbox（存在性惰性创建）。
fn sandbox_temp_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(SANDBOX_TEMP_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("sandbox temp dir create failed: {error}"))?;
    Ok(dir)
}

/// 继承父进程环境，仅把 TMP/TEMP 重定向到沙盒临时目录（UTF-16 双 NUL 结尾块）。
fn environment_block(redirect_temp: &Path) -> Result<Vec<u16>, String> {
    let temp_value = redirect_temp.to_string_lossy().into_owned();
    let mut block = String::new();
    let mut redirected = false;
    for entry in std::env::vars_os() {
        let (key, value) = match entry {
            (key, value) => (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            ),
        };
        let upper = key.to_ascii_uppercase();
        if upper == "TMP" || upper == "TEMP" {
            if redirected {
                continue;
            }
            redirected = true;
            block.push_str(&format!("TMP={temp_value}\0TEMP={temp_value}\0"));
            continue;
        }
        block.push_str(&format!("{key}={value}\0"));
    }
    if !redirected {
        block.push_str(&format!("TMP={temp_value}\0TEMP={temp_value}\0"));
    }
    block.push('\0');
    Ok(block.encode_utf16().collect())
}

/// 双端可继承匿名管道；读端立即去继承，避免子进程持有读端导致 EOF 不达。
unsafe fn inheritable_pipe() -> Result<(HANDLE, HANDLE), String> {
    let mut sa = SECURITY_ATTRIBUTES::default();
    sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
    sa.bInheritHandle = true.into();
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    CreatePipe(&mut read, &mut write, Some(&sa), 0)
        .map_err(|error| format!("CreatePipe failed: {error}"))?;
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT.0 as _)
        .map_err(|error| format!("SetHandleInformation failed: {error}"))?;
    Ok((read, write))
}
```

> 注意：`SetHandleInformation(read, ...)` 的第三个参数应为**清零**继承位，目标语义是
> "移除读端可继承位"。windows crate 版本差异可能使其形如
> `SetHandleInformation(read, HANDLE_FLAG_INHERIT, HANDLE_FLAGS(0))` 或以 `0u32` 传入，
> 以编译门为准修正 API 形状；**语义保持"读端不可继承"不变**。

- [ ] **Step 5.2: 读端循环与参数引用辅助（追加到 launch.rs）**

```rust
/// 读端循环：与 shell.rs drain_pipe 同语义（8KiB 缓冲、256KiB 截断、丢读保畅通）。
/// 句柄所有权归本线程，EOF 后负责 CloseHandle。
fn read_pipe_to_string(pipe: HANDLE) -> std::thread::JoinHandle<(String, bool)> {
    std::thread::spawn(move || {
        let mut collected: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        unsafe {
            loop {
                let mut read: u32 = 0;
                let ok = ReadFile(
                    pipe,
                    Some(buffer.as_mut_ptr().cast()),
                    buffer.len() as u32,
                    Some(&mut read),
                    None,
                );
                if ok.is_err() || read == 0 {
                    break;
                }
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(collected.len());
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let take = (read as usize).min(remaining);
                collected.extend_from_slice(&buffer[..take]);
                if take < read as usize {
                    truncated = true;
                }
            }
            let _ = CloseHandle(pipe);
        }
        (String::from_utf8_lossy(&collected).into_owned(), truncated)
    })
}

/// 与 std::process::Command 的 Windows 参数引用规则一致。
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|b| b == b' ' || b == b'\t' || b == b'"') {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(ch);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}
```

- [ ] **Step 5.3: 实现 provider 并接入工厂**

`crates/system-runtime/src/sandbox/windows/mod.rs` 补全为：

```rust
//! Windows 受限令牌沙箱 provider（codex unelevated 同族）。
//! 网络不做 OS 强制：allowNetwork 仅协议透传，审批是流程性闸门（如实上报）。

pub(crate) mod acl;
pub(crate) mod launch;
pub(crate) mod token;

use crate::sandbox::{SandboxProvider, SandboxRequest};
use crate::shell::ShellOutcome;

pub(crate) struct WindowsTokenSandbox;

impl SandboxProvider for WindowsTokenSandbox {
    fn id(&self) -> &'static str {
        "windows-token"
    }

    fn is_available(&self) -> bool {
        token::probe()
    }

    /// fail-closed：工厂已选定本 provider，令牌缺失时必须报错而非回退无沙箱执行。
    fn exec_direct(
        &self,
        request: &SandboxRequest,
        on_spawn: &dyn Fn(u32),
    ) -> Option<Result<ShellOutcome, String>> {
        Some(match token::restricted_token() {
            Some(token) => launch::exec(request, token, on_spawn),
            None => Err("sandbox token unavailable (fail-closed)".to_string()),
        })
    }
}
```

`mod.rs`（sandbox 根）的 `select()` 已在 Task 1 写好 `#[cfg(windows)]` 分支，无需改动。

- [ ] **Step 5.4: 编译门（双 target）**

```bash
cargo check --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: 双 target 通过（API 形状差异按编译反馈修正）

- [ ] **Step 5.5: Commit**

```bash
git add crates/system-runtime/src/sandbox/windows/
git commit -m "feat(runtime): Windows 沙箱执行器（CreateProcessAsUserW+Job Object）与 provider"
```

---

### Task 6: Rust 协议接线（params/grant/handlers/ready）

**Files:**
- Modify: `crates/system-runtime/src/params.rs:96-102`
- Modify: `crates/system-runtime/src/grant.rs`
- Modify: `crates/system-runtime/src/handlers.rs:242-287`（handle_shell_execute）
- Modify: `crates/system-runtime/src/protocol.rs:30-40`（ready_message）
- Test: grant.rs / params.rs 内联 `#[cfg(test)]`

- [ ] **Step 6.1: 写失败测试（grant 网络核对 + params 缺省）**

`crates/system-runtime/src/grant.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn grant_json(sandbox_network: bool) -> String {
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        format!(
            r#"{{"grantId":"g1","requestId":"r1","sessionId":"s1","workspaceId":"/w",
                "operation":"shell.execute","scope":"once","expiresAt":{expires_at},
                "sandboxNetwork":{sandbox_network}}}"#
        )
    }

    #[test]
    fn accepts_network_when_declared() {
        assert!(require_network_approval(&grant_json(true)).is_ok());
    }

    #[test]
    fn rejects_network_without_declaration() {
        let error = require_network_approval(&grant_json(false)).unwrap_err();
        assert_eq!(error.code, "network_approval_required");
    }

    #[test]
    fn rejects_malformed_grant_for_network_check() {
        let error = require_network_approval("not-json").unwrap_err();
        assert_eq!(error.code, "invalid_grant");
    }
}
```

`crates/system-runtime/src/params.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_params_allow_network_defaults_to_none() {
        let params: ShellParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "command": "echo hi",
            "grant": "g",
        }))
        .unwrap();
        assert_eq!(params.allow_network, None);
    }

    #[test]
    fn shell_params_allow_network_parses_true() {
        let params: ShellParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "command": "echo hi",
            "grant": "g",
            "allowNetwork": true,
        }))
        .unwrap();
        assert_eq!(params.allow_network, Some(true));
    }
}
```

- [ ] **Step 6.2: 跑测试确认失败**

Run: `cargo test --manifest-path crates/Cargo.toml`
Expected: 编译失败（`require_network_approval`、`allow_network` 未定义）

- [ ] **Step 6.3: 实现**

`crates/system-runtime/src/params.rs` 的 `ShellParams`（deny_unknown_fields 不变）追加字段：

```rust
pub struct ShellParams {
    pub workspace_root: String,
    pub command: String,
    pub cwd: Option<String>,
    pub grant: String,
    pub timeout_ms: Option<u64>,
    pub allow_network: Option<bool>,
}
```

`crates/system-runtime/src/grant.rs`：`ApprovalGrant` 结构体追加字段：

```rust
    #[serde(default)]
    sandbox_network: bool,
```

并在 `require_grant` 之后追加：

```rust
/// allowNetwork=true 时核对 grant 中的网络放行声明（防前端绕过审批）。
pub fn require_network_approval(grant: &str) -> Result<(), OpError> {
    let grant: ApprovalGrant = serde_json::from_str(grant).map_err(|_| {
        OpError::new(
            "invalid_grant",
            "network approval check requires a valid grant".to_string(),
        )
    })?;
    if !grant.sandbox_network {
        return Err(OpError::new(
            "network_approval_required",
            "command network access requires an approved sandbox_network grant".to_string(),
        ));
    }
    Ok(())
}
```

`crates/system-runtime/src/protocol.rs` 的 `ready_message` 改为：

```rust
pub fn ready_message() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "system.ready",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "capabilities": ["system.bootstrap", "system.tools"],
            "sandbox": crate::sandbox::provider().id(),
        }
    })
}
```

`crates/system-runtime/src/handlers.rs`：import 区 `use crate::grant::require_grant;` 改为

```rust
use crate::grant::{require_grant, require_network_approval};
```

`use crate::{files, git, mutate, paths, search, shell};` 加入 `sandbox`：

```rust
use crate::{files, git, mutate, paths, sandbox, search, shell};
```

`handle_shell_execute` 整体替换为：

```rust
pub fn handle_shell_execute(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: ShellParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "shell.execute")?;
    let allow_network = params.allow_network.unwrap_or(false);
    if allow_network {
        require_network_approval(&params.grant)?;
    }
    let root = workspace_root(&params.workspace_root)?;
    let cwd_relative = params.cwd.as_deref().unwrap_or(".");
    let cwd = paths::resolve_in_workspace(&root, cwd_relative)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(shell::DEFAULT_TIMEOUT_MS)
        .min(shell::MAX_TIMEOUT_MS);
    // 异步执行：长命令不阻塞主循环，system.cancel 才能被及时处理。
    let request_id = shell_request_id(&id)?;
    let request = sandbox::SandboxRequest {
        command: params.command,
        cwd,
        timeout_ms,
        allow_network,
        writable_roots: vec![root, std::env::temp_dir().join("reflexion-sandbox")],
    };
    std::thread::spawn(move || {
        let provider = sandbox::provider();
        let sandbox_meta = json!({
            "active": provider.id() != "none",
            "provider": provider.id(),
        });
        let outcome = match provider.exec_direct(&request, &|pid| {
            let _ = running_shells().lock().map(|mut shells| {
                shells.insert(request_id.clone(), pid);
            });
        }) {
            Some(result) => result,
            None => shell::execute(
                &provider.wrap(request.command.clone()),
                &request.cwd,
                request.timeout_ms,
                &|pid| {
                    let _ = running_shells().lock().map(|mut shells| {
                        shells.insert(request_id.clone(), pid);
                    });
                },
            ),
        };
        let _ = running_shells().lock().map(|mut shells| {
            shells.remove(&request_id);
        });
        match outcome {
            Ok(outcome) => emit(ok_response(
                id,
                json!({
                    "exitCode": outcome.exit_code,
                    "stdout": outcome.stdout,
                    "stderr": outcome.stderr,
                    "timedOut": outcome.timed_out,
                    "truncated": outcome.truncated,
                    "sandbox": sandbox_meta,
                }),
            )),
            Err(message) => emit(error_response(
                id,
                -32000,
                &message,
                Some(json!({ "code": "execution_failed" })),
            )),
        }
    });
    // 哨兵：回包由完成线程异步发出。
    Ok((Value::Null, false))
}
```

- [ ] **Step 6.4: 跑测试确认通过（全量）**

Run: `cargo test --manifest-path crates/Cargo.toml`
Expected: 全绿（含既有 shell.rs 测试与新 grant/params/sandbox 测试）

- [ ] **Step 6.5: 编译门 + Commit**

```bash
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
git add crates/system-runtime/src/
git commit -m "feat(runtime): shell.execute 沙箱分发 + allowNetwork grant 核对 + ready 能力位"
```

---

### Task 7: TS 工具参数与审批接线（S3）

**Files:**
- Modify: `apps/runtime/src/agent/tools/shell.ts`
- Modify: `apps/runtime/src/agent/permissions.ts:214-246`（GrantIdentity/builders）
- Modify: `apps/runtime/src/agent/tool-executor.ts:123-193`（网络审批分支）
- Create: `apps/runtime/test/network-approval.test.mjs`
- Modify: `apps/runtime/package.json`（test script 追加新测试文件）

- [ ] **Step 7.1: 写失败测试**

创建 `apps/runtime/test/network-approval.test.mjs`：

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApprovalGateway,
  buildOnceGrant,
  buildSessionGrant,
} from '../dist/agent/permissions.js'

function emitter(runId) {
  return { runId, next: () => {} }
}

test('grant builders carry sandboxNetwork declaration', () => {
  const once = JSON.parse(
    buildOnceGrant({
      grantId: 'g1',
      requestId: 'r1',
      sessionId: 's1',
      workspaceRoot: '/w',
      operation: 'shell.execute',
      sandboxNetwork: true,
    }),
  )
  assert.equal(once.sandboxNetwork, true)
  const session = JSON.parse(
    buildSessionGrant({
      grantId: 'session:shell.execute',
      requestId: 'r2',
      sessionId: 's1',
      workspaceRoot: '/w',
      operation: 'shell.execute',
    }),
  )
  assert.equal(session.sandboxNetwork, false)
})

test('sandbox_network session grant is independent from shell.execute', async () => {
  const gateway = new ApprovalGateway()
  const context = { sessionId: 'session-n', workspaceRoot: '/workspace/n' }
  const pending = gateway.request({
    toolCallId: 'n1',
    emitter: emitter('run-n'),
    operation: 'sandbox_network',
    summary: 'npm install',
    signal: new AbortController().signal,
    context,
  })
  gateway.resolve('n1', 'approved', 'session')
  await pending
  assert.equal(gateway.hasSessionGrant('sandbox_network', context), true)
  assert.equal(gateway.hasSessionGrant('shell.execute', context), false)
})
```

`apps/runtime/package.json` 的 test script 文件列表加入 `test/network-approval.test.mjs`
（追加在 `test/approval-gateway.test.mjs` 之后）。

- [ ] **Step 7.2: 跑测试确认失败**

Run: `pnpm --filter @reflexion-os-studio/runtime build && pnpm --filter @reflexion-os-studio/runtime test`
Expected: `sandboxNetwork` 字段断言失败（builders 未输出该字段）

- [ ] **Step 7.3: 实现 permissions.ts**

`GrantIdentity` 增加可选字段，两个 builder 输出该字段（false 显式输出，Rust 侧
`#[serde(default)]` 对两种形态都兼容）：

```ts
interface GrantIdentity {
  grantId: string
  requestId: string
  sessionId: string
  workspaceRoot: string | null
  operation: string
  sandboxNetwork?: boolean
}

/** once 凭据：ask 批准后以本次调用为凭据，时效 5 分钟。 */
export function buildOnceGrant(input: GrantIdentity): string {
  return JSON.stringify({
    grantId: input.grantId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceRoot ?? '',
    operation: input.operation,
    scope: 'once',
    expiresAt: Date.now() + 5 * 60 * 1000,
    sandboxNetwork: input.sandboxNetwork === true,
  })
}

/** session 凭据：同一调用的稳定引用授权，时效 30 分钟（内存态，重启失效）。 */
export function buildSessionGrant(input: GrantIdentity): string {
  return JSON.stringify({
    grantId: input.grantId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceRoot ?? '',
    operation: input.operation,
    scope: 'session',
    expiresAt: Date.now() + 30 * 60 * 1000,
    sandboxNetwork: input.sandboxNetwork === true,
  })
}
```

- [ ] **Step 7.4: 实现 tool-executor.ts 网络审批分支**

在 askNeeded 块之后、`grant = buildOnceGrant(...)`（约 L164）之前插入；随后给三个 grant
构造调用（buildOnceGrant / decision==='ask' 的 buildSessionGrant / trusted 的
buildSessionGrant）都追加 `sandboxNetwork,` 参数：

```ts
  // 网络审批独立链路（spec §5）：任何模式（含 trusted）不自动放行；
  // 会话级授权存网关（键含 operation），本会话后续网络命令免二次询问。
  let sandboxNetwork = false
  const networkRequested =
    request.name === 'shell.execute' &&
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    (args as Record<string, unknown>).requires_network === true
  if (networkRequested) {
    const networkContext = {
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
    }
    if (input.approvals.hasSessionGrant('sandbox_network', networkContext)) {
      sandboxNetwork = true
    } else {
      store.runs.setIntermediateStatus(run.id, 'awaiting_approval')
      let verdict: 'approved' | 'denied'
      try {
        verdict = await input.approvals.request({
          toolCallId: `${row.id}:network`,
          emitter,
          operation: 'sandbox_network',
          summary: summarizeArgs(request.name, args),
          signal,
          context: networkContext,
        })
      } finally {
        if (!input.approvals.hasPendingRun(run.id)) {
          store.runs.setIntermediateStatus(run.id, 'running')
        }
      }
      if (verdict === 'denied') {
        finalizeToolCall(store, state, emitter, row.id, 'failed', 'permission_denied')
        return {
          content: '用户拒绝了本次命令联网请求',
          isError: true,
          code: 'permission_denied',
        }
      }
      sandboxNetwork = true
    }
  }
```

- [ ] **Step 7.5: 实现 shell.ts 参数透出**

三处最小 diff 改动：

1. 工具 description 末尾追加：`沙箱默认禁网：命令需要联网（npm install / git push / curl 等）时必须将 requires_network 置 true 并等待用户批准，未声明时未来 OS 沙箱内必失败。`
2. `parameters.properties` 增加：

```ts
        requires_network: {
          type: 'boolean',
          description:
            '命令是否需要联网（npm install / git push / curl 等）。需要联网时必须置 true，将触发独立的网络审批；缺省 false。',
        },
```

3. `execute` 内（cwd 判断块之后）增加：

```ts
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        (args as Record<string, unknown>).requires_network === true
      ) {
        params.allowNetwork = true
      }
```

- [ ] **Step 7.6: 跑测试确认通过**

Run: `pnpm --filter @reflexion-os-studio/runtime build && pnpm --filter @reflexion-os-studio/runtime test`
Expected: 全绿（含 runner/approval-gateway 既有测试回归）

- [ ] **Step 7.7: Commit**

```bash
git add apps/runtime/
git commit -m "feat(runtime): shell 网络审批闭环（requires_network→sandbox_network→grant）"
```

---

### Task 8: 前端审批卡标签

**Files:**
- Modify: `apps/desktop/frontend/features/chat/ApprovalCard.tsx:3-14`

- [ ] **Step 8.1: OPERATION_LABELS 增加 sandbox_network**

```ts
  'shell.execute': '执行命令',
  'sandbox_network': '允许命令联网',
}
```

- [ ] **Step 8.2: 前端验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过

- [ ] **Step 8.3: Commit**

```bash
git add apps/desktop/frontend/features/chat/ApprovalCard.tsx
git commit -m "feat(frontend): sandbox_network 审批卡标签"
```

---

### Task 9: 文档更新与全链验证

**Files:**
- Modify: `docs/SHELL-SANDBOX-PLAN.md`
- Modify: `docs/PERMISSION-MODEL.md:77`
- Modify: `AGENTS.md`（§1 能力清单）

- [ ] **Step 9.1: SHELL-SANDBOX-PLAN.md 更新**

- §2 非目标：移除"Windows（受限 token）"，保留 Linux bwrap；追加"codex elevated 档（专用
  沙盒用户+防火墙+UAC）、私有桌面、network_proxy 域名策略"为非目标；
- §4.2：trait 描述改为双路径（`wrap` + `exec_direct`），标注 Windows 自持执行与
  ReflexionOS 教训，引用 spec 文档；
- 新增 §4.5「Windows 受限令牌沙箱」：机制表（token/acl/launch）+ 三个能力边界
  （网络不强制/敏感路径读不保护/ACL 持久标签）+ codex unelevated 对照；写边界说明
  workspace root + 专用沙盒临时目录（TMP/TEMP 重定向，不给整个用户 TEMP 打标签）；
- §4.4 能力位枚举改为 `"windows-token" | "none"`（开放枚举，未来 `seatbelt`/`bwrap`）；
- §5 表格追加：| W1 | 沙箱骨架+工厂 | 非 Windows 工厂返回 none；cargo test 全绿 |
  | W2 | Windows provider | cargo check --target x86_64-pc-windows-msvc 通过；真机验收
  （token 生效/workspace 外写被拒/Job 树杀/TEMP 重定向生效）留待 Windows 环境 |
  | W3 | 网络审批闭环 | requires_network 触发审批卡；session 放行后免询问；
  无声明的 allowNetwork 被 Rust 拒绝（network_approval_required）|；
- §7 决策记录追加：Windows 机制档位、双路径 trait、网络审批纳入、trusted 不旁路、
  fail-closed（引用 spec §10）。

- [ ] **Step 9.2: PERMISSION-MODEL.md L77 更新**

该行改为（保留 Phase 6 语义，仅修正"Windows Job Object"的归属表述并指向新设计）：

```markdown
Phase 1 的 Rust 是应用级执行边界；shell 域的平台级沙箱按 SHELL-SANDBOX-PLAN.md 分档推进
（macOS Seatbelt、Windows 受限令牌档已立项），bubblewrap/seccomp 等其余平台级隔离放到 Phase 6。
```

- [ ] **Step 9.3: AGENTS.md 能力清单补记**

§1 Tools 条目末尾追加一句：

```markdown
Shell 沙箱：SandboxProvider 工厂 + Windows 受限令牌档（低完整性写边界 + Job Object，网络不
OS 强制）+ 按命令网络审批（requires_network → sandbox_network 卡 → grant.sandboxNetwork）。
```

- [ ] **Step 9.4: 全链验证（AGENTS.md §6 顺序）**

```bash
source ~/.cargo/env
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @reflexion-os-studio/desktop typecheck
pnpm build:packages
cargo fmt --manifest-path crates/Cargo.toml -- --check
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path crates/Cargo.toml --target x86_64-pc-windows-msvc
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: 全部通过。**不需要** `pnpm build:desktop`（无 TS 宿主/前端结构性变更时可选）。

- [ ] **Step 9.5: Commit**

```bash
git add docs/ AGENTS.md
git commit -m "docs: 沙箱计划纳入 Windows 受限令牌档与网络审批闭环"
```
