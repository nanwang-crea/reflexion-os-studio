use serde_json::{json, Value};

#[derive(Debug)]
pub struct EditError {
    pub message: String,
    pub diagnostic: Option<Value>,
}
impl From<String> for EditError {
    fn from(message: String) -> Self {
        Self {
            message,
            diagnostic: None,
        }
    }
}
impl EditError {
    pub fn operation(
        index: usize,
        kind: &str,
        reason: &str,
        message: String,
        extra: Value,
    ) -> Self {
        let mut diagnostic = json!({"operationIndex": index, "kind": kind, "reason": reason, "noChangesWritten": true});
        if let (Some(target), Some(extra)) = (diagnostic.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        Self {
            message: format!("edits[{index}]: {message}"),
            diagnostic: Some(diagnostic),
        }
    }
}
