use super::{digest_path, file_error, require_grant, workspace_root, OpError};
use crate::params::EditParams;
use serde_json::{json, Value};

pub fn handle_file_edit(params: Value) -> Result<Value, OpError> {
    if params.get("edits").is_some()
        && ["oldText", "newText", "expectedCount"]
            .iter()
            .any(|key| params.get(key).is_some())
    {
        return Err(OpError::new(
            "invalid_request",
            "edits cannot be combined with legacy parameters, including null values".to_string(),
        ));
    }
    let params: EditParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.edit",
        &[digest_path(&params.path)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    let edits = match (params.edits, params.old_text, params.new_text) {
        (Some(edits), None, None) if !edits.is_empty() && params.expected_count.is_none() => edits,
        (None, Some(old_text), Some(new_text)) => vec![crate::params::FileEditOperation::Replace {
            old_text,
            new_text,
            expected_count: params.expected_count,
        }],
        _ => {
            return Err(OpError::new(
                "invalid_request",
                "provide either a non-empty edits array or legacy oldText/newText".to_string(),
            ));
        }
    };
    let outcome = crate::filesystem::edit::edit(&root, &params.path, &edits, params.revision)
        .map_err(|error| {
            let mut result = file_error(error.message);
            if let Some(diagnostic) = &error.diagnostic {
                result.code = match diagnostic["reason"].as_str() {
                    Some("overlap") => "overlapping_edits",
                    Some("invalid_range" | "invalid_match" | "invalid_count") => "invalid_request",
                    _ => "edit_mismatch",
                };
            }
            result.details = error.diagnostic;
            result
        })?;
    Ok(json!({
        "replacedCount": outcome.replaced_count,
        "sizeBytes": outcome.size_bytes,
        "modifiedMs": outcome.modified_ms,
        "revision": {
            "modifiedMs": outcome.revision.modified_ms,
            "sizeBytes": outcome.revision.size_bytes,
            "sha256": outcome.revision.sha256,
        },
        "changedFiles": outcome.changed_files,
        "structuredPatch": outcome.structured_patch,
    }))
}
