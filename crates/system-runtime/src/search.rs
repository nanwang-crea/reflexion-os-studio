//! Workspace 搜索：glob 文件名匹配与字面文本 grep。
//! grep 只做字面子串（非正则），过滤与定位用 glob；遍历边界由 walk 模块保证。
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::glob;
use crate::paths::resolve_in_workspace;
use crate::walk::{walk_files, FileEntry};

pub const MAX_GLOB_RESULTS: usize = 2000;
pub const MAX_GREP_RESULTS: usize = 1000;
/// grep 默认/上限条数：太多会撑爆模型上下文。
pub const DEFAULT_GLOB_LIMIT: usize = 500;
pub const DEFAULT_GREP_LIMIT: usize = 200;
const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GREP_LINE_CHARS: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobOutcome {
    pub matches: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepOutcome {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
}

pub fn glob_search(
    workspace_root: &Path,
    pattern: &str,
    limit: usize,
) -> Result<GlobOutcome, String> {
    let segments = glob::pattern_segments(pattern)?;
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_files(&start, "");
    let limit = limit.min(MAX_GLOB_RESULTS);
    let mut matches = Vec::new();
    for entry in &walked.files {
        let path_segments: Vec<&str> = entry.path.split('/').collect();
        if glob::matches(&segments, &path_segments) {
            matches.push(entry.clone());
            if matches.len() >= limit {
                break;
            }
        }
    }
    // 恰好到上限说明可能还有更多；walk 截断说明还有未扫描的文件。
    let truncated = walked.truncated || matches.len() >= limit;
    Ok(GlobOutcome { matches, truncated })
}

pub fn grep_search(
    workspace_root: &Path,
    text: &str,
    glob_filter: Option<&str>,
    ignore_case: bool,
    limit: usize,
) -> Result<GrepOutcome, String> {
    if text.trim().is_empty() {
        return Err("search text must not be empty".to_string());
    }
    let filter = match glob_filter {
        Some(value) => Some(glob::pattern_segments(value)?),
        None => None,
    };
    let needle = if ignore_case {
        text.to_lowercase()
    } else {
        text.to_string()
    };
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_files(&start, "");
    let limit = limit.min(MAX_GREP_RESULTS);
    let mut matches = Vec::new();
    for entry in &walked.files {
        if let Some(pattern) = &filter {
            let path_segments: Vec<&str> = entry.path.split('/').collect();
            if !glob::matches(pattern, &path_segments) {
                continue;
            }
        }
        if entry.size_bytes > MAX_GREP_FILE_BYTES {
            continue;
        }
        let bytes = match fs::read(start.join(&entry.path)) {
            Ok(value) => value,
            Err(_) => continue,
        };
        // NUL 字节视为二进制文件，跳过而不是报错。
        if bytes.contains(&0) {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(value) => value,
            Err(_) => continue,
        };
        for (index, line) in content.lines().enumerate() {
            let haystack = if ignore_case {
                line.to_lowercase()
            } else {
                line.to_string()
            };
            if !haystack.contains(&needle) {
                continue;
            }
            matches.push(GrepMatch {
                path: entry.path.clone(),
                line: index + 1,
                text: truncate_line(line),
            });
            if matches.len() >= limit {
                return Ok(GrepOutcome {
                    matches,
                    truncated: true,
                });
            }
        }
    }
    Ok(GrepOutcome {
        matches,
        truncated: walked.truncated,
    })
}

fn truncate_line(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() <= MAX_GREP_LINE_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_GREP_LINE_CHARS).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("reflexion-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn glob_finds_files_by_pattern() {
        let root = temp_workspace("glob");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("a.ts"), "a").unwrap();
        fs::write(root.join("src/b.ts"), "b").unwrap();
        fs::write(root.join("c.md"), "c").unwrap();
        let outcome = glob_search(&root, "**/*.ts", DEFAULT_GLOB_LIMIT).unwrap();
        assert_eq!(outcome.matches.len(), 2);
        assert_eq!(outcome.matches[0].path, "a.ts");
        assert_eq!(outcome.matches[1].path, "src/b.ts");
        assert!(!outcome.truncated);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_finds_lines_and_respects_case_flag() {
        let root = temp_workspace("grep");
        fs::write(root.join("note.txt"), "hello World\nsecond line\n").unwrap();
        let found = grep_search(&root, "World", None, false, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line, 1);
        let insensitive = grep_search(&root, "world", None, true, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(insensitive.matches.len(), 1);
        let missing = grep_search(&root, "nope", None, false, DEFAULT_GREP_LIMIT).unwrap();
        assert!(missing.matches.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_skips_binary_files_and_applies_glob_filter() {
        let root = temp_workspace("grep-binary");
        fs::write(root.join("text.txt"), "needle here").unwrap();
        fs::write(root.join("data.bin"), [0u8, 1, 2]).unwrap();
        let outcome = grep_search(&root, "needle", None, false, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].path, "text.txt");
        let filtered =
            grep_search(&root, "needle", Some("*.bin"), false, DEFAULT_GREP_LIMIT).unwrap();
        assert!(filtered.matches.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_rejects_empty_text() {
        let root = temp_workspace("grep-empty");
        assert!(grep_search(&root, "  ", None, false, DEFAULT_GREP_LIMIT).is_err());
        fs::remove_dir_all(&root).ok();
    }
}
