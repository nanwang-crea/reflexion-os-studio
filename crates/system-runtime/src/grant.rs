//! 审批凭据校验：写/执行类工具（file.write/edit/delete/move/mkdir、shell.execute）
//! 在 Rust 边界再次核对 grant 的绑定关系、操作名与时效，作为前端审批的兜底硬边界。

use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::OpError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalGrant {
    grant_id: String,
    request_id: String,
    session_id: String,
    workspace_id: String,
    operation: String,
    scope: String,
    expires_at: u64,
}

pub fn require_grant(grant: &str, workspace_root: &str, operation: &str) -> Result<(), OpError> {
    let grant: ApprovalGrant = serde_json::from_str(grant).map_err(|_| {
        OpError::new(
            "invalid_grant",
            "write/execute operations require a valid approval grant".to_string(),
        )
    })?;
    if grant.grant_id.trim().is_empty()
        || grant.request_id.trim().is_empty()
        || grant.session_id.trim().is_empty()
        || grant.workspace_id != workspace_root
        || grant.operation != operation
        || !matches!(grant.scope.as_str(), "once" | "session")
    {
        return Err(OpError::new(
            "invalid_grant",
            "approval grant does not match this request".to_string(),
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OpError::new("invalid_grant", "invalid system clock".to_string()))?
        .as_millis() as u64;
    if grant.expires_at <= now {
        return Err(OpError::new(
            "grant_expired",
            "approval grant has expired".to_string(),
        ));
    }
    Ok(())
}
