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
