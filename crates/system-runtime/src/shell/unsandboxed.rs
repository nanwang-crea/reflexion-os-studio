//! Explicit once-only approval is independent of sandbox provider availability.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::grant::GrantFacts;
use crate::protocol::OpError;

pub(crate) fn consume(facts: &GrantFacts) -> Result<(), OpError> {
    static USED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OpError::new("invalid_grant", "invalid system clock".into()))?
        .as_millis() as u64;
    let mut used = USED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| OpError::new("invalid_grant", "approval consumption unavailable".into()))?;
    used.retain(|_, expires_at| *expires_at > now);
    if facts.source != "once" || facts.sandbox != "unsandboxed" || facts.expires_at <= now {
        return Err(OpError::new(
            "invalid_grant",
            "unsandboxed execution requires current once approval".into(),
        ));
    }
    if used.contains_key(&facts.grant_id) {
        return Err(OpError::new(
            "grant_consumed",
            "approval already consumed; request approval again".into(),
        ));
    }
    // Refuse rather than evict valid consumed grants and enable replay.
    if used.len() >= 10_000 {
        return Err(OpError::new(
            "invalid_grant",
            "approval consumption capacity exhausted".into(),
        ));
    }
    used.insert(facts.grant_id.clone(), facts.expires_at);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn once_approval_cannot_be_replayed() {
        let facts = GrantFacts {
            grant_id: "unsandboxed-consumption-test".into(),
            expires_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000,
            sandbox: "unsandboxed".into(),
            source: "once".into(),
            escalation_roots: vec![],
        };
        consume(&facts).unwrap();
        assert_eq!(consume(&facts).unwrap_err().code, "grant_consumed");
        let mut automatic = facts.clone();
        automatic.grant_id = "unsandboxed-automatic-test".into();
        automatic.source = "preset".into();
        assert!(consume(&automatic).is_err());
    }
}
