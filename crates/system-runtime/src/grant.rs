//! 审批凭据校验 V2：写/执行类工具（file.write/edit/delete/move/mkdir、shell.execute）
//! 在 Rust 边界再次核对 grant 的绑定关系、操作名、subjectDigest 与时效，
//! 作为前端审批的兜底硬边界。
//!
//! digest 规范串与 TS Runtime `permissions/subjects.ts#canonicalDigest` 逐字节一致：
//! `"v2"`、operation、资源部分按 `"<utf8字节长度>:<内容>"` 长度前缀拼接后取 sha256，
//! 杜绝路径/命令内的分隔符歧义注入。session rule 只决定"是否免问"，
//! 不能把旧 grant 复用给不同资源/命令——重算不匹配即拒绝。

use serde::Deserialize;
use sha2::{Digest, Sha256};
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
    source: String,
    subject_digest: String,
    sandbox: String,
    #[serde(default)]
    escalation_roots: Vec<String>,
    sandbox_network: bool,
    expires_at: u64,
    version: u8,
}

/// 与 TS 侧同算法的规范化相对路径：`\`→`/`、去空段与 `.` 段；
/// 拒绝绝对路径、盘符与 `..` 段。返回 None 表示非法（等同复核失败）。
pub fn normalize_relative(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let slashed = trimmed.replace('\\', "/");
    if slashed.starts_with('/') {
        return None;
    }
    {
        let bytes = slashed.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return None;
        }
    }
    let mut segments = Vec::new();
    for segment in slashed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        return Some(".".to_string());
    }
    Some(segments.join("/"))
}

/// 长度前缀拼接（parts 已含 "v2" 与 operation）。
pub fn canonical_digest_from_parts(parts: &[String]) -> String {
    let mut joined = String::new();
    for piece in parts {
        joined.push_str(&format!("{}:{}", piece.as_bytes().len(), piece));
    }
    let digest = Sha256::digest(joined.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{hex}")
}

/// 构造侧便捷函数（operation + 资源部分 → digest）；测试与 Runtime 对齐用。
#[cfg(test)]
pub fn canonical_digest(operation: &str, parts: &[&str]) -> String {
    let mut all = vec!["v2".to_string(), operation.to_string()];
    all.extend(parts.iter().map(|part| part.to_string()));
    canonical_digest_from_parts(&all)
}

fn parse_grant(grant: &str) -> Result<ApprovalGrant, OpError> {
    serde_json::from_str(grant).map_err(|_| {
        OpError::new(
            "invalid_grant",
            "write/execute operations require a valid approval grant".to_string(),
        )
    })
}

/// grant 解析结果：handler 据此选择沙箱档位与网络语义（单一权威来源是
/// 已通过复核的 grant 字段，不是请求侧可自由声明的参数）。
#[derive(Debug, Clone)]
pub struct GrantFacts {
    pub sandbox: String,
    pub source: String,
    /// escalated 档的审批提权根（参与 digest 绑定；handler 再独立复核）。
    pub escalation_roots: Vec<String>,
}

/// 校验 grant 并复核 subjectDigest。`resource_parts` 为已规范化的资源身份：
/// 文件操作 = [path]（move = [from, to]）；shell = [command, cwd]，
/// sandbox / network 两段由 grant 自身字段补齐（篡改即失配）。
pub fn require_grant(
    grant: &str,
    workspace_root: &str,
    operation: &str,
    resource_parts: &[String],
) -> Result<GrantFacts, OpError> {
    let parsed = parse_grant(grant)?;
    if parsed.version != 2
        || parsed.grant_id.trim().is_empty()
        || parsed.request_id.trim().is_empty()
        || parsed.session_id.trim().is_empty()
        || parsed.workspace_id != workspace_root
        || parsed.operation != operation
        || !matches!(
            parsed.source.as_str(),
            "once" | "session-rule" | "preset" | "danger-lease"
        )
        || !parsed.subject_digest.starts_with("sha256:")
        || !matches!(
            parsed.sandbox.as_str(),
            "read-only" | "workspace-write" | "escalated" | "danger"
        )
        // danger 档只能来自 danger-lease（普通审批永远给不出系统范围访问）。
        || (parsed.sandbox == "danger" && parsed.source != "danger-lease")
        // 提权根只能挂在 escalated 档上（其余档位必须为空，防静默扩边界）。
        || (!parsed.escalation_roots.is_empty() && parsed.sandbox != "escalated")
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
    if parsed.expires_at <= now {
        return Err(OpError::new(
            "grant_expired",
            "approval grant has expired".to_string(),
        ));
    }
    // subjectDigest 复核：按实际请求重算，与 grant 携带值逐字符比较。
    // shell 身份 = command + cwd +（escalated 时的提权根）+ sandbox + network，
    // 后段取自 grant 自身字段——篡改档位、根集合或网络标志一律失配。
    let mut parts = vec!["v2".to_string(), operation.to_string()];
    parts.extend(resource_parts.iter().cloned());
    if operation == "shell.execute" {
        parts.extend(parsed.escalation_roots.iter().cloned());
        parts.push(parsed.sandbox.clone());
        parts.push(if parsed.sandbox_network { "1" } else { "0" }.to_string());
    }
    if canonical_digest_from_parts(&parts) != parsed.subject_digest {
        return Err(OpError::new(
            "approval_subject_mismatch",
            "approval grant does not match the actual resource of this request".to_string(),
        ));
    }
    Ok(GrantFacts {
        sandbox: parsed.sandbox,
        source: parsed.source,
        escalation_roots: parsed.escalation_roots,
    })
}

/// 兼容入口：仅结构校验（无资源复核）。UI 来源与无需 digest 绑定的场景使用。
fn require_grant_shape(grant: &str) -> Result<ApprovalGrant, OpError> {
    let parsed = parse_grant(grant)?;
    if parsed.version != 2 || !parsed.subject_digest.starts_with("sha256:") {
        return Err(OpError::new(
            "invalid_grant",
            "approval grant does not match this request".to_string(),
        ));
    }
    Ok(parsed)
}

pub fn require_network_approval(grant: &str) -> Result<(), OpError> {
    let parsed = require_grant_shape(grant)?;
    if !parsed.sandbox_network {
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

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    /// shell 的 resource_parts 只含 [command, cwd]；sandbox/network 由
    /// require_grant 从 grant 自身补齐（篡改即失配），与 handler 传参一致。
    fn shell_parts(command: &str, cwd: &str) -> Vec<String> {
        vec![command.to_string(), cwd.to_string()]
    }

    /// 构造与 require_grant 同算法的合法 grant（digest 按 parts 现算）。
    fn grant_with(
        operation: &str,
        resource_parts: &[String],
        sandbox: &str,
        sandbox_network: bool,
        expires_at: u64,
    ) -> String {
        grant_with_roots(
            operation,
            resource_parts,
            sandbox,
            sandbox_network,
            &[],
            expires_at,
        )
    }

    fn grant_with_roots(
        operation: &str,
        resource_parts: &[String],
        sandbox: &str,
        sandbox_network: bool,
        roots: &[&str],
        expires_at: u64,
    ) -> String {
        let mut parts = vec!["v2".to_string(), operation.to_string()];
        parts.extend(resource_parts.iter().cloned());
        if operation == "shell.execute" {
            parts.extend(roots.iter().map(|r| r.to_string()));
            parts.push(sandbox.to_string());
            parts.push(if sandbox_network { "1" } else { "0" }.to_string());
        }
        let digest = canonical_digest_from_parts(&parts);
        let roots_json: Vec<String> = roots.iter().map(|root| format!("\"{root}\"")).collect();
        format!(
            r#"{{"version":2,"grantId":"g1","requestId":"r1","sessionId":"s1","workspaceId":"/w",
                "operation":"{operation}","source":"once","subjectDigest":"{digest}",
                "sandbox":"{sandbox}","escalationRoots":[{roots_join}],"sandboxNetwork":{sandbox_network},"expiresAt":{expires_at}}}"#,
            roots_join = roots_json.join(",")
        )
    }

    fn shell_grant(network: bool) -> String {
        grant_with(
            "shell.execute",
            &shell_parts("git status", "."),
            "workspace-write",
            network,
            now_millis() + 60_000,
        )
    }

    #[test]
    fn canonical_digest_matches_ts_reference_vectors() {
        // TS canonicalDigest(...) 的真实输出（跨实现一致性钉死）。
        assert_eq!(
            canonical_digest("file.write", &["a.txt"]),
            "sha256:1e6f9812a2091ec0827d40e989b2570fb612ac4b6262021241faf5f337402d53"
        );
        assert_eq!(
            canonical_digest("file.move", &["a.txt", "b/c.txt"]),
            "sha256:a726f778d9fcfea3992aa2884288a8439a74ab3a83b2087e70181ecf373f5b7e"
        );
    }

    #[test]
    fn normalize_relative_accepts_and_rejects() {
        assert_eq!(normalize_relative("a/b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(
            normalize_relative(".\\a\\b.txt").as_deref(),
            Some("a/b.txt")
        );
        assert_eq!(normalize_relative("./a//b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(normalize_relative(".").as_deref(), Some("."));
        assert_eq!(normalize_relative("a/").as_deref(), Some("a"));
        assert_eq!(normalize_relative(""), None);
        assert_eq!(normalize_relative("/etc/passwd"), None);
        assert_eq!(normalize_relative("C:\\secrets\\id"), None);
        assert_eq!(normalize_relative("a/../b"), None);
        assert_eq!(normalize_relative("../escape"), None);
    }

    #[test]
    fn accepts_matching_digests() {
        let parts = shell_parts("git status", ".");
        assert!(require_grant(&shell_grant(false), "/w", "shell.execute", &parts).is_ok());
        let write = grant_with(
            "file.write",
            &["src/app.ts".to_string()],
            "workspace-write",
            false,
            now_millis() + 60_000,
        );
        assert!(require_grant(&write, "/w", "file.write", &["src/app.ts".to_string()]).is_ok());
    }

    #[test]
    fn rejects_digest_mismatch_with_approval_subject_mismatch() {
        // 批准 a.txt 的凭据不能用于 b.txt（session 复用换目标的兜底）。
        let write = grant_with(
            "file.write",
            &["a.txt".to_string()],
            "workspace-write",
            false,
            now_millis() + 60_000,
        );
        let error = require_grant(&write, "/w", "file.write", &["b.txt".to_string()]).unwrap_err();
        assert_eq!(error.code, "approval_subject_mismatch");
        // shell：换命令同样失配。
        let error = require_grant(
            &shell_grant(false),
            "/w",
            "shell.execute",
            &shell_parts("git push --force", "."),
        )
        .unwrap_err();
        assert_eq!(error.code, "approval_subject_mismatch");
        // digest 被替换成无关值即失配。
        let tampered = grant_with(
            "file.write",
            &["a.txt".to_string()],
            "workspace-write",
            false,
            now_millis() + 60_000,
        )
        .replace("sha256:", "sha256:dead");
        assert!(require_grant(&tampered, "/w", "file.write", &["a.txt".to_string()]).is_err());
    }

    #[test]
    fn escalation_roots_bind_into_digest_and_require_escalated_tier() {
        let future = now_millis() + 60_000;
        let escalated = grant_with_roots(
            "shell.execute",
            &shell_parts("git config", "."),
            "escalated",
            false,
            &["/Users/dev/notes"],
            future,
        );
        let facts = require_grant(
            &escalated,
            "/w",
            "shell.execute",
            &shell_parts("git config", "."),
        )
        .expect("escalated grant with bound roots");
        assert_eq!(facts.escalation_roots, vec!["/Users/dev/notes".to_string()]);
        // 非 escalated 档携带提权根：直接失效（不静默吞掉）。
        let wrong_tier = grant_with_roots(
            "shell.execute",
            &shell_parts("git config", "."),
            "workspace-write",
            false,
            &["/Users/dev/notes"],
            future,
        );
        assert_eq!(
            require_grant(
                &wrong_tier,
                "/w",
                "shell.execute",
                &shell_parts("git config", "."),
            )
            .unwrap_err()
            .code,
            "invalid_grant"
        );
    }

    #[test]
    fn accepts_network_when_declared() {
        assert!(require_network_approval(&shell_grant(true)).is_ok());
    }

    #[test]
    fn rejects_network_without_declaration() {
        let error = require_network_approval(&shell_grant(false)).unwrap_err();
        assert_eq!(error.code, "network_approval_required");
    }

    #[test]
    fn rejects_malformed_grant_for_network_check() {
        let error = require_network_approval("not-json").unwrap_err();
        assert_eq!(error.code, "invalid_grant");
    }

    #[test]
    fn rejects_legacy_scope_shaped_grant() {
        // 旧 grant（scope 字段、无 version/digest）必须整体失效：字段形状不符即拒绝。
        let legacy = r#"{"grantId":"g1","requestId":"r1","sessionId":"s1","workspaceId":"/w",
            "operation":"shell.execute","scope":"once","expiresAt":99999999999999}"#;
        let error = require_grant(legacy, "/w", "shell.execute", &[]).unwrap_err();
        assert_eq!(error.code, "invalid_grant");
    }

    #[test]
    fn rejects_workspace_or_operation_mismatch() {
        let parts = shell_parts("git status", ".");
        assert!(require_grant(&shell_grant(false), "/other", "shell.execute", &parts).is_err());
        assert!(require_grant(&shell_grant(false), "/w", "file.write", &parts).is_err());
    }

    #[test]
    fn rejects_expired_grant() {
        let body = grant_with(
            "file.write",
            &["a.txt".to_string()],
            "workspace-write",
            false,
            1,
        );
        let error = require_grant(&body, "/w", "file.write", &["a.txt".to_string()]).unwrap_err();
        assert_eq!(error.code, "grant_expired");
    }

    #[test]
    fn rejects_unknown_source_or_sandbox() {
        let good = grant_with(
            "file.write",
            &["a.txt".to_string()],
            "workspace-write",
            false,
            now_millis() + 60_000,
        );
        let bad_source = good.replace("\"source\":\"once\"", "\"source\":\"permanent\"");
        assert!(require_grant(&bad_source, "/w", "file.write", &["a.txt".to_string()]).is_err());
        let bad_sandbox = good.replace(
            "\"sandbox\":\"workspace-write\"",
            "\"sandbox\":\"no-sandbox\"",
        );
        assert!(require_grant(&bad_sandbox, "/w", "file.write", &["a.txt".to_string()]).is_err());
    }
}
