//! Shell 沙箱抽象：平台 provider 工厂（Noop 降级 / Windows 受限令牌 / 未来 Seatbelt、bwrap）。
//! 设计：docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md。
//! 双路径 trait：包装型 provider（Seatbelt/bwrap）实现 wrap；自持执行型（Windows）
//! 实现 exec_direct。工厂进程内选定一次，选定后执行失败 fail-closed，不回退无沙箱。

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::shell::ShellOutcome;

pub(crate) mod noop;
#[cfg(windows)]
pub(crate) mod windows;

pub(crate) use noop::NoopSandbox;

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
        assert_eq!(
            provider().wrap("echo hi".to_string()),
            "echo hi".to_string()
        );
    }
}
