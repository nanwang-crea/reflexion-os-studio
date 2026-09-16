//! Shell 沙箱抽象：平台 provider 工厂（Noop 降级 / Windows 受限令牌 / macOS Seatbelt / Linux bwrap）。
//! 设计：docs/superpowers/specs/2026-09-12-shell-sandbox-windows-design.md。
//! 双路径 trait：包装型 provider（Seatbelt/bwrap）实现 wrap；自持执行型（Windows）
//! 实现 exec_direct。工厂进程内选定一次，选定后执行失败 fail-closed，不回退无沙箱。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::shell::ShellOutcome;

pub(crate) mod noop;
// Seatbelt/bwrap 渲染器全平台编译（纯字符串/std::process），便于跨机单测；
// select() 仅在对应平台 cfg 分支消费（其余平台构建靠 cfg_attr 放行 dead_code）。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) mod linux;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) mod macos;
#[cfg(windows)]
pub(crate) mod windows;

pub(crate) use noop::NoopSandbox;

/// 沙箱能力档位（权限模型 V2 §10.3）：与"是否要问"的权限决策正交，
/// 决定"获批后实际能访问什么"。任一 provider 无法可靠应用所选档位时
/// 必须 fail-closed（handler 层拒绝），不得降级为无沙箱后继续执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxAccess {
    ReadOnly,
    WorkspaceWrite,
    Escalated,
    Danger,
}

impl SandboxAccess {
    /// grant.sandbox 字符串 → 档位；未知值按最窄的 ReadOnly 处理（fail-closed）。
    pub(crate) fn from_grant(value: &str) -> Self {
        match value {
            "workspace-write" => Self::WorkspaceWrite,
            "escalated" => Self::Escalated,
            "danger" => Self::Danger,
            _ => Self::ReadOnly,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::Escalated => "escalated",
            Self::Danger => "danger",
        }
    }
}

/// 一次 shell 执行的沙箱请求（handlers 组装，provider 消费）。
#[allow(dead_code)] // allow_network/writable_roots 由平台 provider 渲染消费（部分平台构建下未用）
pub(crate) struct SandboxRequest {
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_ms: u64,
    pub allow_network: bool,
    /// 能力档位；writable_roots 由 handler 按档位装配（provider 不再自行放大）。
    pub access: SandboxAccess,
    /// 可写边界（Windows：打 LOW 完整性标签；macOS 进 Seatbelt profile）。
    /// 顺序约定：按档位为 [workspace_root?, sandbox_temp_dir, escalation_roots...]；
    /// Escalated 的额外根已在 handler 侧通过敏感路径与深度校验。
    pub writable_roots: Vec<PathBuf>,
}

/// 最长现存祖先 canonicalize 后拼回缺失尾段（提权根与敏感根比对共用；
/// macOS profile_path 同源语义：/var→/private/var 类符号链接必须解析后比较）。
pub(crate) fn deepest_resolved(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(resolved) = std::fs::canonicalize(ancestor) {
            let tail = path.strip_prefix(ancestor).unwrap_or(path);
            return resolved.join(tail);
        }
    }
    path.to_path_buf()
}

/// 沙盒专用临时目录（Windows：LOW 标签 + TMP/TEMP 重定向目标；handlers 与 provider 共用唯一定义）。
pub(crate) fn sandbox_temp_dir() -> PathBuf {
    std::env::temp_dir().join("reflexion-sandbox")
}

/// 运行数据的敏感根清单（与 macOS/Linux provider 的拒读清单同源）。
pub(crate) fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    std::env::var_os("REFLEXION_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".reflexion-os-studio"))
}

/// 提权/危险档位一律不得覆盖的敏感路径（双向重叠即拒绝：既不能是敏感路径
/// 内部，也不能是敏感路径的祖先——不给任何平台留"粗根吞掉凭据目录"的洞）。
pub(crate) fn sensitive_roots() -> Vec<PathBuf> {
    let mut roots = vec![data_dir()];
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Some(home) = home {
        for tail in [".ssh", ".aws", ".gnupg", ".config/gcloud", ".docker"] {
            roots.push(home.join(tail));
        }
    }
    #[cfg(unix)]
    {
        roots.push(PathBuf::from("/etc"));
    }
    #[cfg(windows)]
    if let Some(windir) = std::env::var_os("SystemRoot") {
        roots.push(PathBuf::from(windir));
    }
    roots
}

pub(crate) trait SandboxProvider: Send + Sync {
    /// 稳定标识，进入协议："windows-token" / "seatbelt" / "bwrap" / "none"。
    fn id(&self) -> &'static str;

    /// 工厂探测：不可用则降级 Noop。仅在工厂初始化时调用一次。
    #[cfg_attr(
        not(any(windows, target_os = "macos", target_os = "linux")),
        allow(dead_code)
    )] // 三平台 select() 分支都探测；其余 unix（如 *BSD）构建不消费
    fn is_available(&self) -> bool;

    /// 该 provider 能否可靠应用所选 access（handler 在装配前询问；
    /// 不能即 fail-closed，绝不静默降为更宽或无沙箱执行）。
    /// 默认：read-only / workspace-write / escalated 可应用；danger 需平台
    /// 显式开通（保留敏感拒读的系统范围 profile 落地后返回 true）。
    fn supports_access(&self, access: SandboxAccess) -> bool {
        !matches!(access, SandboxAccess::Danger)
    }

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

/// 进程内唯一 provider：按平台探测（Windows 受限令牌 / macOS Seatbelt / Linux bwrap），
/// 探测不过降级 Noop。
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
    #[cfg(target_os = "linux")]
    {
        let provider = linux::BwrapSandbox::from_env();
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
            access: SandboxAccess::WorkspaceWrite,
            writable_roots: vec![],
        };
        assert!(NoopSandbox.wrap(&request).is_none());
    }
}
