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
