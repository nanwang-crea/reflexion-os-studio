//! Metadata-only preflight and execution-time validation share the same boundary.
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{deepest_resolved, provider, sensitive_roots, SandboxAccess};
use crate::filesystem::paths;
use crate::protocol::{workspace_root, OpError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareParams {
    workspace_root: String,
    cwd: String,
    escalation_roots: Vec<String>,
}

pub(crate) fn prepare(params: Value) -> Result<Value, OpError> {
    let params: PrepareParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let sandbox = provider();
    if !sandbox.supports_access(SandboxAccess::Escalated) {
        return Err(OpError::new(
            "sandbox_policy_unavailable",
            "当前平台没有可用的提权沙箱，未申请授权或执行命令".into(),
        ));
    }
    let root = workspace_root(&params.workspace_root)?;
    let cwd = paths::resolve_in_workspace(&root, &params.cwd)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    if !cwd.is_dir() {
        return Err(OpError::new(
            "invalid_request",
            "工作目录必须是现存目录".into(),
        ));
    }
    let roots = resolve_escalation_roots(&params.escalation_roots, sandbox.id())?;
    Ok(json!({ "escalationRoots": roots, "sandboxProvider": sandbox.id() }))
}

fn protected_name(path: &Path) -> bool {
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_lowercase();
        matches!(
            name.as_str(),
            ".ssh"
                | ".aws"
                | ".gnupg"
                | "pgp"
                | ".docker"
                | ".npmrc"
                | ".netrc"
                | "credentials.json"
                | "secrets.json"
                | "id_token"
        ) || name.starts_with(".env")
            || name.ends_with(".key")
            || name.ends_with(".pem")
            || name.ends_with(".token")
            || name.starts_with("id_rsa")
            || name.starts_with("id_ed25519")
    })
}

pub(crate) fn resolve_escalation_roots(
    raw: &[String],
    provider: &str,
) -> Result<Vec<PathBuf>, OpError> {
    if raw.is_empty() || raw.len() > 8 {
        return Err(OpError::new(
            "invalid_request",
            "提权范围必须包含 1–8 个明确路径".into(),
        ));
    }
    let sensitive = sensitive_roots();
    let mut out = Vec::new();
    for value in raw {
        let declared = PathBuf::from(value);
        if !declared.is_absolute()
            || value.len() > 4096
            || value.chars().any(char::is_control)
            || declared
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(OpError::new(
                "invalid_request",
                "提权范围必须是绝对路径，不允许 .. 或控制字符".into(),
            ));
        }
        if declared
            .components()
            .filter(|part| matches!(part, Component::Normal(_)))
            .count()
            < 2
        {
            return Err(OpError::new(
                "permission_denied",
                "提权范围过宽，请指定具体文件或目录".into(),
            ));
        }
        // Check lexical credential names before touching filesystem metadata.
        if protected_name(&declared) {
            return Err(OpError::new(
                "permission_denied",
                "提权范围涉及受保护凭据路径".into(),
            ));
        }
        let canonical = deepest_resolved(&declared);
        if canonical
            .components()
            .filter(|part| matches!(part, Component::Normal(_)))
            .count()
            < 2
        {
            return Err(OpError::new(
                "permission_denied",
                "提权范围过宽，请指定具体文件或目录".into(),
            ));
        }
        if protected_name(&canonical)
            || sensitive.iter().any(|guard| {
                let guard = deepest_resolved(guard);
                canonical.starts_with(&guard) || guard.starts_with(&canonical)
            })
        {
            return Err(OpError::new(
                "permission_denied",
                "提权范围与受保护凭据范围重叠".into(),
            ));
        }
        // bwrap needs a bind source; Windows needs an existing object to label.
        // Never create a target or widen to its parent before approval.
        if matches!(provider, "bwrap" | "windows-token") && !canonical.exists() {
            return Err(OpError::new(
                "sandbox_policy_unavailable",
                "此平台的提权范围必须已存在；新建目标请显式申请合适的现存非敏感父目录".into(),
            ));
        }
        if !out.contains(&canonical) {
            out.push(canonical);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_relative_parent_and_credentials() {
        assert!(resolve_escalation_roots(&[], "seatbelt").is_err());
        for path in [
            "relative",
            "/",
            "/tmp",
            "/tmp/a/../b",
            "/tmp/project/.env.local",
            "/tmp/project/secrets.json",
        ] {
            assert!(
                resolve_escalation_roots(&[path.into()], "seatbelt").is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn missing_bind_targets_rejected_without_creating_them() {
        let path = std::env::temp_dir()
            .join(format!("reflexion-missing-scope-{}", std::process::id()))
            .join("space dir");
        let raw = vec![path.to_string_lossy().into_owned()];
        assert!(resolve_escalation_roots(&raw, "seatbelt").is_ok());
        assert!(resolve_escalation_roots(&raw, "bwrap").is_err());
        assert!(resolve_escalation_roots(&raw, "windows-token").is_err());
        assert!(!path.exists());
    }
}
