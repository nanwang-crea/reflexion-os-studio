//! Shell 沙箱抽象：平台 provider 工厂（Noop 降级 / Windows 受限令牌 / macOS Seatbelt / Linux bwrap）。
//! 设计：docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md。
//! 双路径 trait：包装型 provider（Seatbelt/bwrap）实现 wrap；自持执行型（Windows）
//! 实现 exec_direct。工厂进程内选定一次，选定后执行失败 fail-closed，不回退无沙箱。

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::shell::ShellOutcome;

pub(crate) mod noop;
// Seatbelt 渲染器全平台编译（纯字符串/std::process），便于跨机单测；
// select() 仅在 macOS 分支消费（Linux bwrap 接入前，其余平台构建靠此放行 dead_code）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) mod macos;
#[cfg(windows)]
pub(crate) mod windows;

pub(crate) use noop::NoopSandbox;

/// 一次 shell 执行的沙箱请求（handlers 组装，provider 消费）。
#[allow(dead_code)] // allow_network/writable_roots 由平台 provider 渲染消费（部分平台构建下未用）
pub(crate) struct SandboxRequest {
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_ms: u64,
    pub allow_network: bool,
    /// 可写边界（Windows：打 LOW 完整性标签；macOS 下轮进 Seatbelt profile）。
    /// 顺序约定：[workspace_root, sandbox_temp_dir]。
    pub writable_roots: Vec<PathBuf>,
}

/// 沙盒专用临时目录（Windows：LOW 标签 + TMP/TEMP 重定向目标；handlers 与 provider 共用唯一定义）。
pub(crate) fn sandbox_temp_dir() -> PathBuf {
    std::env::temp_dir().join("reflexion-sandbox")
}

pub(crate) trait SandboxProvider: Send + Sync {
    /// 稳定标识，进入协议："windows-token" / "none"（未来追加 "seatbelt" / "bwrap"）。
    fn id(&self) -> &'static str;

    /// 工厂探测：不可用则降级 Noop。仅在工厂初始化时调用一次。
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))] // Linux bwrap 接入前，该平台 select() 不探测
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

    /// 包装路径（轮次 B）：返回完整 argv（launcher + `-- sh -c <command>`）。
    /// None = 不包装（Noop 现状路径）。请求上下文经 `SandboxRequest` 进入渲染。
    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        let _ = request;
        None
    }
}

/// 进程内唯一 provider：按平台探测（Windows 受限令牌 / macOS Seatbelt），探测不过降级 Noop。
pub(crate) fn provider() -> &'static dyn SandboxProvider {
    static PROVIDER: OnceLock<Box<dyn SandboxProvider>> = OnceLock::new();
    PROVIDER.get_or_init(select).as_ref()
}

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
