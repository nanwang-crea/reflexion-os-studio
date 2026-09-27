//! 单文件文本 patch：解析全部操作、拒绝冲突并一次原子提交。
use std::{fs, path::Path};

use serde::Serialize;

use super::{
    files::{self, Revision, MAX_WRITE_BYTES},
    mutate::{changed, ChangedFile},
    paths::resolve_in_workspace,
};
use crate::params::FileEditOperation;

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
}

pub fn edit(
    workspace_root: &Path,
    relative: &str,
    edits: &[FileEditOperation],
    revision: Option<Revision>,
) -> Result<EditOutcome, String> {
    if edits.is_empty() {
        return Err("edits must not be empty".to_string());
    }
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}"));
    }
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_WRITE_BYTES as u64 {
        return Err(format!(
            "file too large for edit: {size} bytes (limit {MAX_WRITE_BYTES})"
        ));
    }
    let token = revision.ok_or_else(|| {
        format!("file.edit requires readToken: run file.read on '{relative}' first")
    })?;
    validate_revision(&path, relative, size, &token)?;
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if super::sha256::hex_digest(original.as_bytes()) != token.sha256 {
        return Err(format!("file content changed since last read (same mtime but sha256 mismatch); re-run file.read on '{relative}' before editing"));
    }

    let had_bom = original.starts_with('\u{feff}');
    let body = original.strip_prefix('\u{feff}').unwrap_or(&original);
    let uses_crlf = body.contains("\r\n");
    let mut updated = body.replace("\r\n", "\n");
    let mut resolved = Vec::new();
    for operation in edits {
        resolve_operation(&updated, operation, &mut resolved)?;
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
        ));
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

fn resolve_operation(
    content: &str,
    operation: &FileEditOperation,
    output: &mut Vec<ResolvedEdit>,
) -> Result<(), String> {
    match operation {
        FileEditOperation::Replace {
            old_text,
            new_text,
            expected_count,
        } => resolve_matches(
            content,
            "replace",
            old_text,
            new_text,
            *expected_count,
            output,
        ),
        FileEditOperation::InsertBefore {
            anchor,
            content: inserted,
            expected_count,
        } => resolve_matches(
            content,
            "insert_before",
            anchor,
            inserted,
            *expected_count,
            output,
        ),
        FileEditOperation::InsertAfter {
            anchor,
            content: inserted,
            expected_count,
        } => resolve_matches(
            content,
            "insert_after",
            anchor,
            inserted,
            *expected_count,
            output,
        ),
        FileEditOperation::ReplaceRange {
            start_line,
            end_line,
            expected_text,
            new_text,
        } => {
            let (start, end) = line_range(content, *start_line, *end_line)?;
            if content[start..end] != normalize(expected_text) {
                return Err(format!("replace_range expectedText does not match lines {start_line}-{end_line}; no changes written"));
            }
            output.push(resolved(
                content,
                "replace_range",
                start,
                end,
                normalize(new_text),
            ));
            Ok(())
        }
    }
}

fn resolve_matches(
    content: &str,
    kind: &str,
    needle: &str,
    replacement: &str,
    expected: Option<usize>,
    output: &mut Vec<ResolvedEdit>,
) -> Result<(), String> {
    let mut needle = normalize(needle);
    if needle.is_empty() {
        return Err(format!("{kind} match text must not be empty"));
    }
    let mut positions = match_positions(content, &needle);
    if positions.is_empty() {
        let stripped = strip_line_prefixes(&needle);
        if stripped != needle {
            needle = stripped;
            positions = match_positions(content, &needle);
        }
    }
    let expected = expected.unwrap_or(1).max(1);
    if positions.len() != expected {
        return Err(format!(
            "{kind} match appears {} time(s), expectedCount is {expected}; no changes written",
            positions.len()
        ));
    }
    let replacement = normalize(replacement);
    for start in positions {
        let (start, end) = match kind {
            "insert_before" => (start, start),
            "insert_after" => (start + needle.len(), start + needle.len()),
            _ => (start, start + needle.len()),
        };
        output.push(resolved(content, kind, start, end, replacement.clone()));
    }
    Ok(())
}

fn match_positions(content: &str, needle: &str) -> Vec<usize> {
    content
        .match_indices(needle)
        .map(|(index, _)| index)
        .collect()
}

fn resolved(
    content: &str,
    kind: &str,
    start: usize,
    end: usize,
    replacement: String,
) -> ResolvedEdit {
    ResolvedEdit {
        start,
        end,
        patch: StructuredPatchChange {
            kind: kind.to_string(),
            start_line: line_number(content, start),
            end_line: line_number(content, end),
            before: content[start..end].to_string(),
            after: replacement.clone(),
        },
        replacement,
    }
}

fn reject_overlaps(edits: &[ResolvedEdit]) -> Result<(), String> {
    for pair in edits.windows(2) {
        if pair[0].end > pair[1].start
            || (pair[0].start == pair[0].end && pair[0].start == pair[1].start)
        {
            return Err("edit operations overlap; no changes written".to_string());
        }
    }
    Ok(())
}

fn normalize(value: &str) -> String {
    value.replace("\r\n", "\n")
}
fn line_number(content: &str, offset: usize) -> usize {
    content[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

fn line_range(content: &str, start_line: usize, end_line: usize) -> Result<(usize, usize), String> {
    if start_line == 0 || end_line < start_line {
        return Err("replace_range requires 1-based startLine <= endLine".to_string());
    }
    let mut starts = vec![0];
    starts.extend(content.match_indices('\n').map(|(index, _)| index + 1));
    if start_line > starts.len() || end_line > starts.len() {
        return Err(format!(
            "replace_range lines {start_line}-{end_line} are outside the file"
        ));
    }
    Ok((
        starts[start_line - 1],
        if end_line < starts.len() {
            starts[end_line] - 1
        } else {
            content.len()
        },
    ))
}

fn strip_line_prefixes(value: &str) -> String {
    value
        .split('\n')
        .map(|line| {
            let Some(rest) = line.strip_prefix('L') else {
                return line;
            };
            let Some((digits, content)) = rest.split_once(": ") else {
                return line;
            };
            if digits.chars().all(|character| character.is_ascii_digit()) {
                content
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests;
