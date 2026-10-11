use super::{EditError, ResolvedEdit, StructuredPatchChange};
use crate::params::FileEditOperation;

pub(super) fn resolve_operation(
    content: &str,
    operation: &FileEditOperation,
    operation_index: usize,
    had_bom: bool,
    output: &mut Vec<ResolvedEdit>,
) -> Result<(), EditError> {
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
            operation_index,
            had_bom,
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
            operation_index,
            had_bom,
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
            operation_index,
            had_bom,
            output,
        ),
        FileEditOperation::ReplaceRange {
            start_line,
            end_line,
            expected_text,
            new_text,
        } => {
            let (start, end) = line_range(content, *start_line, *end_line).map_err(|message| {
                EditError::operation(
                    operation_index,
                    "replace_range",
                    "invalid_range",
                    message,
                    serde_json::json!({"startLine": start_line, "endLine": end_line}),
                )
            })?;
            let expected = normalize(expected_text);
            let actual = &content[start..end];
            let matches = |text: &str| {
                actual == text
                    || (had_bom
                        && *start_line == 1
                        && actual == text.strip_prefix('\u{feff}').unwrap_or(text))
            };
            if !matches(&expected)
                && !strip_numbered_range(&expected, *start_line, *end_line)
                    .is_some_and(|text| matches(&text))
            {
                return Err(EditError::operation(operation_index, "replace_range", "text_mismatch", format!("replace_range expectedText does not match lines {start_line}-{end_line}; no changes written"), serde_json::json!({"startLine": start_line, "endLine": end_line})));
            }
            output.push(resolved(
                content,
                "replace_range",
                start,
                end,
                normalize(new_text),
                operation_index,
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
    operation_index: usize,
    had_bom: bool,
    output: &mut Vec<ResolvedEdit>,
) -> Result<(), EditError> {
    let mut needle = normalize(needle);
    if needle.is_empty() {
        return Err(EditError::operation(
            operation_index,
            kind,
            "invalid_match",
            format!("{kind} match text must not be empty"),
            serde_json::json!({}),
        ));
    }
    let mut positions = match_positions(content, &needle);
    if positions.is_empty() {
        let stripped = strip_line_prefixes(&needle);
        if stripped != needle {
            needle = stripped;
            positions = match_positions(content, &needle);
        }
    }
    // file.read includes a UTF-8 BOM on the first displayed line. Only
    // accept its removal when this file has a BOM and the match starts at 0.
    if positions.is_empty() && had_bom {
        if let Some(stripped) = needle.strip_prefix('\u{feff}') {
            if !stripped.is_empty() && content.starts_with(stripped) {
                needle = stripped.to_string();
                positions = vec![0];
            }
        }
    }
    let expected = expected.unwrap_or(1);
    if expected == 0 {
        return Err(EditError::operation(
            operation_index,
            kind,
            "invalid_count",
            "expectedCount must be positive".to_string(),
            serde_json::json!({}),
        ));
    }
    if positions.len() != expected {
        return Err(EditError::operation(
            operation_index,
            kind,
            "match_count",
            format!(
                "{kind} match appears {} time(s), expectedCount is {expected}; no changes written",
                positions.len()
            ),
            serde_json::json!({"actualCount": positions.len(), "expectedCount": expected, "candidateLines": positions.iter().take(20).map(|offset| line_number(content, *offset)).collect::<Vec<_>>()}),
        ));
    }
    let replacement = normalize(replacement);
    for start in positions {
        let (start, end) = match kind {
            "insert_before" => (start, start),
            "insert_after" => (start + needle.len(), start + needle.len()),
            _ => (start, start + needle.len()),
        };
        output.push(resolved(
            content,
            kind,
            start,
            end,
            replacement.clone(),
            operation_index,
        ));
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
    operation_index: usize,
) -> ResolvedEdit {
    ResolvedEdit {
        operation_index,
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

pub(super) fn reject_overlaps(edits: &[ResolvedEdit]) -> Result<(), EditError> {
    for pair in edits.windows(2) {
        if pair[0].end > pair[1].start
            || (pair[0].start == pair[0].end && pair[0].start == pair[1].start)
        {
            return Err(EditError::operation(
                pair[1].operation_index,
                &pair[1].patch.kind,
                "overlap",
                "edit operations overlap; no changes written".to_string(),
                serde_json::json!({"conflictingOperationIndex": pair[0].operation_index}),
            ));
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

fn strip_numbered_range(value: &str, start: usize, end: usize) -> Option<String> {
    let lines: Vec<_> = value.split('\n').collect();
    if lines.len() != end - start + 1 {
        return None;
    }
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| line.strip_prefix(&format!("L{}: ", start + index)))
        .collect::<Option<Vec<_>>>()
        .map(|lines| lines.join("\n"))
}
