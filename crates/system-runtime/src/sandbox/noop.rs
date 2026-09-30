//! Noop provider：表示当前平台没有可用的 OS 沙箱。
//!
//! Noop 不执行 Shell，也不声称能够应用任何 SandboxAccess；需要沙箱的请求
//! 必须由 handler fail-closed。

use super::{SandboxAccess, SandboxProvider};

pub(crate) struct NoopSandbox;

impl SandboxProvider for NoopSandbox {
    fn id(&self) -> &'static str {
        "none"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn supports_access(&self, _access: SandboxAccess) -> bool {
        false
    }
}
