//! Noop provider：无 OS 沙箱时的降级终点（保持现状执行路径与语义）。
//! 只能如实执行 read-only / workspace-write（workspace-write 无 OS 强制即尽力而为）；
//! 对 escalation / danger fail-closed——无法验证的提权绝不允许假装已提权后放行。

use super::{SandboxAccess, SandboxProvider};

pub(crate) struct NoopSandbox;

impl SandboxProvider for NoopSandbox {
    fn id(&self) -> &'static str {
        "none"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn supports_access(&self, access: SandboxAccess) -> bool {
        matches!(
            access,
            SandboxAccess::ReadOnly | SandboxAccess::WorkspaceWrite
        )
    }
}
