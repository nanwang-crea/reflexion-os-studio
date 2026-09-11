//! Workspace 搜索：glob 文件名匹配与字面文本 grep。
//! grep 只做字面子串（非正则），过滤与定位用 glob；遍历边界由 walk 模块保证。
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::glob;
use crate::paths::resolve_in_workspace;
use crate::walk::{walk_files, FileEntry};

pub const MAX_GLOB_RESULTS: usize = 2000;
/// grep 单次调用的全工作区累计上限（跨文件累计，非单文件上限）。
pub const MAX_GREP_RESULTS: usize = 1000;
/// grep 默认/上限条数：太多会撑爆模型上下文。
pub const DEFAULT_GLOB_LIMIT: usize = 500;
pub const DEFAULT_GREP_LIMIT: usize = 200;
/// 命中行前后附带的上下文行数上限：过大无益，总量由调用方截断层兜底。
pub const MAX_GREP_CONTEXT: usize = 5;
const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GREP_LINE_CHARS: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobOutcome {
    pub matches: Vec<FileEntry>,
    pub truncated: bool,
    /// 仍有后续页时指向下一次请求的 offset；与 file.list 同构。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepLine {
    /// 1-based 绝对行号。
    pub line: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    /// 1-based 绝对行号。
    pub line: usize,
    pub text: String,
    /// 命中行前后的上下文行（按行号升序；跳过本身命中的行）。
    /// context=0 时整体省略，JSON 形状与无上下文调用完全一致。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<GrepLine>,
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
    offset: Option<usize>,
    limit: usize,
) -> Result<GlobOutcome, String> {
    let segments = glob::pattern_segments(pattern)?;
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_files(&start, "");
    let limit = limit.clamp(1, MAX_GLOB_RESULTS);
    // 全量收集后再分页：match 到 limit 即 break 是有偏截断，
    // 排序完整的匹配集才能给出稳定可续读的 offset 语义。
    let mut all: Vec<FileEntry> = Vec::new();
    for entry in &walked.files {
        let path_segments: Vec<&str> = entry.path.split('/').collect();
        if glob::matches(&segments, &path_segments) {
            all.push(entry.clone());
        }
    }
    let offset = offset.unwrap_or(0);
    let page: Vec<FileEntry> = all.iter().skip(offset).take(limit).cloned().collect();
    let page_end = offset.saturating_add(page.len());
    let more = page_end < all.len();
    // walk 截断说明还有未扫描的文件；more 说明匹配集还有下一页。
    Ok(GlobOutcome {
        matches: page,
        truncated: walked.truncated || more,
        next_offset: if more { Some(page_end) } else { None },
    })
}

pub fn grep_search(
    workspace_root: &Path,
    text: &str,
    glob_filter: Option<&str>,
    ignore_case: bool,
    context: usize,
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
    let context = context.min(MAX_GREP_CONTEXT);
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_files(&start, "");
    let limit = limit.clamp(1, MAX_GREP_RESULTS);
    let mut matches: Vec<GrepMatch> = Vec::new();
    // W3：limit 是全工作区累计上限——旧实现按文件各自计数，
    // 多文件各命中少量行时总量可静默远超 limit。
    let mut total: usize = 0;
    let mut hit_limit = false;
    'files: for entry in &walked.files {
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
        let lines: Vec<&str> = content.lines().collect();
        // 本文件最多消耗的剩余配额。
        let remaining = limit - total;
        let mut matched: Vec<usize> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let haystack = if ignore_case {
                line.to_lowercase()
            } else {
                line.to_string()
            };
            if !haystack.contains(&needle) {
                continue;
            }
            matched.push(index);
            if matched.len() >= remaining {
                break;
            }
        }
        let matched_set: HashSet<usize> = matched.iter().copied().collect();
        for &index in &matched {
            let mut context_lines = Vec::new();
            if context > 0 {
                let first = index.saturating_sub(context);
                let last = (index + context).min(lines.len().saturating_sub(1));
                for neighbour in first..=last {
                    if neighbour == index || matched_set.contains(&neighbour) {
                        continue;
                    }
                    context_lines.push(GrepLine {
                        line: neighbour + 1,
                        text: truncate_line(lines[neighbour]),
                    });
                }
            }
            matches.push(GrepMatch {
                path: entry.path.clone(),
                line: index + 1,
                text: truncate_line(lines[index]),
                context: context_lines,
            });
        }
        total += matched.len();
        if total >= limit {
            // 已达全局累计上限：停止扫描后续文件，调用方可按 glob 收窄后重试。
            hit_limit = true;
            break 'files;
        }
    }
    Ok(GrepOutcome {
        matches,
        truncated: hit_limit || walked.truncated,
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
        let outcome = glob_search(&root, "**/*.ts", None, DEFAULT_GLOB_LIMIT).unwrap();
        assert_eq!(outcome.matches.len(), 2);
        assert_eq!(outcome.matches[0].path, "a.ts");
        assert_eq!(outcome.matches[1].path, "src/b.ts");
        assert!(!outcome.truncated);
        assert_eq!(outcome.next_offset, None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn glob_paginates_with_offset_and_next_offset() {
        let root = temp_workspace("glob-offset");
        fs::write(root.join("a.ts"), "a").unwrap();
        fs::write(root.join("b.ts"), "b").unwrap();
        fs::write(root.join("c.ts"), "c").unwrap();
        let first = glob_search(&root, "*.ts", None, 2).unwrap();
        assert_eq!(first.matches.len(), 2);
        assert_eq!(first.matches[0].path, "a.ts");
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));
        let second = glob_search(&root, "*.ts", first.next_offset, 2).unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].path, "c.ts");
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_finds_lines_and_respects_case_flag() {
        let root = temp_workspace("grep");
        fs::write(root.join("note.txt"), "hello World\nsecond line\n").unwrap();
        let found = grep_search(&root, "World", None, false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line, 1);
        let insensitive = grep_search(&root, "world", None, true, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(insensitive.matches.len(), 1);
        let missing = grep_search(&root, "nope", None, false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert!(missing.matches.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_context_includes_neighbours_and_skips_matched_lines() {
        let root = temp_workspace("grep-context");
        fs::write(
            root.join("code.txt"),
            "l0\nl1 needle\nl2\nl3\nl4 needle\nl5\n",
        )
        .unwrap();
        let outcome = grep_search(&root, "needle", None, false, 2, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(outcome.matches.len(), 2);
        assert_eq!(outcome.matches[0].line, 2);
        let lines_of = |m: &GrepMatch| -> Vec<usize> {
            m.context
                .iter()
                .map(|context_line| context_line.line)
                .collect()
        };
        // 命中行 2 的上下文：1..4 去掉自身；行 5 本身命中，不重复出现。
        assert_eq!(lines_of(&outcome.matches[0]), vec![1, 3, 4]);
        assert_eq!(outcome.matches[1].line, 5);
        assert_eq!(lines_of(&outcome.matches[1]), vec![3, 4, 6]);
        // context=0 时字段整体省略（与既有 JSON 形状一致）。
        let plain = grep_search(&root, "l0", None, false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert!(plain.matches[0].context.is_empty());
        let serialized = serde_json::to_value(&plain.matches[0]).unwrap();
        assert!(serialized.get("context").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_skips_binary_files_and_applies_glob_filter() {
        let root = temp_workspace("grep-binary");
        fs::write(root.join("text.txt"), "needle here").unwrap();
        fs::write(root.join("data.bin"), [0u8, 1, 2]).unwrap();
        let outcome = grep_search(&root, "needle", None, false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].path, "text.txt");
        let filtered =
            grep_search(&root, "needle", Some("*.bin"), false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert!(filtered.matches.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn zero_limit_returns_at_most_one_result_for_each_search() {
        let root = temp_workspace("zero-limit");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("a.ts"), "needle").unwrap();
        fs::write(root.join("src/b.ts"), "needle").unwrap();

        let glob = glob_search(&root, "**/*.ts", None, 0).unwrap();
        assert_eq!(glob.matches.len(), 1);
        assert!(glob.truncated);

        let grep = grep_search(&root, "needle", None, false, 0, 0).unwrap();
        assert_eq!(grep.matches.len(), 1);
        assert!(grep.truncated);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_limit_is_global_across_files() {
        let root = temp_workspace("grep-global-limit");
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(root.join(name), "needle\nother\nneedle\n").unwrap();
        }
        // 旧实现按文件计数：每文件 2 命中均不触达 limit=5，会静默返回 6 条。
        // 新实现跨文件累计：恰好 5 条即停扫并标记截断。
        let outcome = grep_search(&root, "needle", None, false, 0, 5).unwrap();
        assert_eq!(outcome.matches.len(), 5);
        assert!(outcome.truncated);
        let by_file: HashSet<&str> = outcome.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(by_file.contains("a.txt"));
        assert!(by_file.contains("b.txt"));
        assert!(by_file.contains("c.txt"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_rejects_empty_text() {
        let root = temp_workspace("grep-empty");
        assert!(grep_search(&root, "  ", None, false, 0, DEFAULT_GREP_LIMIT).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn glob_and_grep_skip_dependency_directories() {
        let root = temp_workspace("skip-deps");
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("node_modules/pkg/dep.ts"), "needle").unwrap();
        fs::write(root.join("src/main.ts"), "needle").unwrap();

        let glob = glob_search(&root, "**/*.ts", None, DEFAULT_GLOB_LIMIT).unwrap();
        assert_eq!(glob.matches.len(), 1);
        assert_eq!(glob.matches[0].path, "src/main.ts");
        assert!(!glob.truncated);

        let grep = grep_search(&root, "needle", None, false, 0, DEFAULT_GREP_LIMIT).unwrap();
        assert_eq!(grep.matches.len(), 1);
        assert_eq!(grep.matches[0].path, "src/main.ts");
        assert!(!grep.truncated);

        fs::remove_dir_all(&root).ok();
    }
}
