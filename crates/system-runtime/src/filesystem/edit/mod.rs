//! 单文件文本 patch：解析全部操作、拒绝冲突并一次原子提交。
use std::{fs, path::Path};

use serde::Serialize;

use super::{
    files::{self, Revision, MAX_WRITE_BYTES},
    mutate::{changed, ChangedFile},
    paths::resolve_in_workspace,
};
use crate::params::FileEditOperation;
mod error;
mod resolve;
pub use error::EditError;
use resolve::{reject_overlaps, resolve_operation};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredPatchChange {
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
    pub before: String,
    pub after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub replaced_count: usize,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub revision: Revision,
    pub changed_files: Vec<ChangedFile>,
    pub structured_patch: Vec<StructuredPatchChange>,
}

struct ResolvedEdit {
    start: usize,
    end: usize,
    replacement: String,
    patch: StructuredPatchChange,
    operation_index: usize,
}

pub fn edit(
    workspace_root: &Path,
    relative: &str,
    edits: &[FileEditOperation],
    revision: Option<Revision>,
) -> Result<EditOutcome, EditError> {
    if edits.is_empty() {
        return Err("edits must not be empty".to_string().into());
    }
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}").into());
    }
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_WRITE_BYTES as u64 {
        return Err(
            format!("file too large for edit: {size} bytes (limit {MAX_WRITE_BYTES})").into(),
        );
    }
    let token = revision.ok_or_else(|| {
        format!("file.edit requires readToken: run file.read on '{relative}' first")
    })?;
    validate_revision(&path, relative, size, &token)?;
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if super::sha256::hex_digest(original.as_bytes()) != token.sha256 {
        return Err(format!("file content changed since last read (same mtime but sha256 mismatch); re-run file.read on '{relative}' before editing").into());
    }

    let had_bom = original.starts_with('\u{feff}');
    let body = original.strip_prefix('\u{feff}').unwrap_or(&original);
    let uses_crlf = body.contains("\r\n");
    let mut updated = body.replace("\r\n", "\n");
    let mut resolved = Vec::new();
    for (index, operation) in edits.iter().enumerate() {
        resolve_operation(&updated, operation, index, had_bom, &mut resolved)?;
    }
    resolved.sort_by_key(|edit| (edit.start, edit.end));
    reject_overlaps(&resolved)?;
    let structured_patch = resolved
        .iter()
        .map(|edit| StructuredPatchChange {
            kind: edit.patch.kind.clone(),
            start_line: edit.patch.start_line,
            end_line: edit.patch.end_line,
            before: edit.patch.before.clone(),
            after: edit.patch.after.clone(),
        })
        .collect();
    for edit in resolved.iter().rev() {
        updated.replace_range(edit.start..edit.end, &edit.replacement);
    }
    if had_bom {
        updated.insert(0, '\u{feff}');
    }
    if uses_crlf {
        updated = updated.replace('\n', "\r\n");
    }
    if updated.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "edited file too large: {} bytes (limit {MAX_WRITE_BYTES})",
            updated.len()
        )
        .into());
    }
    files::atomic_write(&path, updated.as_bytes())?;
    let modified_ms = files::mtime_ms(&path)?;
    let size_bytes = updated.len() as u64;
    Ok(EditOutcome {
        replaced_count: resolved.len(),
        size_bytes,
        modified_ms,
        revision: Revision {
            modified_ms,
            size_bytes,
            sha256: super::sha256::hex_digest(updated.as_bytes()),
        },
        changed_files: vec![changed(relative, "modified")],
        structured_patch,
    })
}

fn validate_revision(
    path: &Path,
    relative: &str,
    size: u64,
    token: &Revision,
) -> Result<(), String> {
    if files::mtime_ms(path)? != token.modified_ms || size != token.size_bytes {
        return Err(format!(
            "file changed since last read; re-run file.read on '{relative}' before editing"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
