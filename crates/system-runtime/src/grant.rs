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
    #[serde(default)]
    sandbox_network: bool,
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
