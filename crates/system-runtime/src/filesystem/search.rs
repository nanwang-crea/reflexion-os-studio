//! Workspace 搜索：glob 文件名匹配与正则 grep。
//! grep 默认按正则匹配，literal=true 时按字面文本；过滤与定位用 glob，遍历边界由 walk 模块保证。
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use regex::{Regex, RegexBuilder};
use serde::Serialize;

use super::glob;
use super::paths::resolve_in_workspace;
use super::walk::{walk_search_files, FileEntry};

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
    pub scan_truncated: bool,
    pub scanned_files: usize,
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
    pub next_offset: Option<usize>,
    pub scan_truncated: bool,
    pub scanned_files: usize,
}

pub fn glob_search(
    workspace_root: &Path,
    pattern: &str,
    offset: Option<usize>,
    limit: usize,
) -> Result<GlobOutcome, String> {
    let matcher = glob::compile(pattern)?;
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_search_files(&start);
    let limit = limit.clamp(1, MAX_GLOB_RESULTS);
    // 全量收集后再分页：match 到 limit 即 break 是有偏截断，
    // 排序完整的匹配集才能给出稳定可续读的 offset 语义。
    let mut all: Vec<FileEntry> = Vec::new();
    for entry in &walked.files {
        if matcher.is_match(&entry.path) {
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
        scan_truncated: walked.truncated,
        scanned_files: walked.scanned_files,
    })
}

#[cfg(test)]
pub fn grep_search(
    workspace_root: &Path,
    pattern: &str,
    glob_filter: Option<&str>,
    ignore_case: bool,
    context: usize,
    limit: usize,
    offset: Option<usize>,
) -> Result<GrepOutcome, String> {
    grep_search_with_mode(
        workspace_root,
        pattern,
        glob_filter,
        ignore_case,
        false,
        context,
        limit,
        offset,
    )
}

pub fn grep_search_with_mode(
    workspace_root: &Path,
    pattern: &str,
    glob_filter: Option<&str>,
    ignore_case: bool,
    literal: bool,
    context: usize,
    limit: usize,
    offset: Option<usize>,
) -> Result<GrepOutcome, String> {
    if pattern.trim().is_empty() {
        return Err("search pattern must not be empty".to_string());
    }
    let filter = match glob_filter {
        Some(value) => Some(glob::compile(value)?),
        None => None,
    };
    let source = if literal {
        regex::escape(pattern)
    } else {
        pattern.to_string()
    };
    let matcher = RegexBuilder::new(&source)
        .case_insensitive(ignore_case)
        .unicode(true)
        .build()
        .map_err(|error| format!("invalid search regex: {error}"))?;
    let context = context.min(MAX_GREP_CONTEXT);
    let start = resolve_in_workspace(workspace_root, ".")?;
    let walked = walk_search_files(&start);
    let limit = limit.clamp(1, MAX_GREP_RESULTS);
    let mut matches: Vec<GrepMatch> = Vec::new();
    // W3：limit 是全工作区累计上限——旧实现按文件各自计数，
    // 多文件各命中少量行时总量可静默远超 limit。
    let offset = offset.unwrap_or(0);
    let mut seen: usize = 0;
    let mut total: usize = 0;
    let mut hit_limit = false;
    'files: for entry in &walked.files {
        if let Some(pattern) = &filter {
            if !pattern.is_match(&entry.path) {
                continue;
            }
        }
        if entry.size_bytes > MAX_GREP_FILE_BYTES {
            let remaining = limit - total;
            let streamed = grep_large_file(
                &start.join(&entry.path),
                &entry.path,
                &matcher,
                context,
                offset,
                &mut seen,
                remaining,
            );
            total += streamed.len();
            matches.extend(streamed);
            if total >= limit {
                hit_limit = true;
                break 'files;
            }
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
            if !matcher.is_match(line) {
                continue;
            }
            if seen < offset {
                seen += 1;
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
        seen += matched.len();
        if total >= limit {
            // 已达全局累计上限：停止扫描后续文件，调用方可按 glob 收窄后重试。
            hit_limit = true;
            break 'files;
        }
    }
    Ok(GrepOutcome {
        matches,
        truncated: hit_limit || walked.truncated,
        next_offset: if hit_limit {
            Some(offset + total)
        } else {
            None
        },
        scan_truncated: walked.truncated,
        scanned_files: walked.scanned_files,
    })
}

fn grep_large_file(
    path: &Path,
    relative: &str,
    matcher: &Regex,
    context: usize,
    offset: usize,
    seen: &mut usize,
    limit: usize,
) -> Vec<GrepMatch> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut matches: Vec<GrepMatch> = Vec::new();
    let mut recent: Vec<(usize, String)> = Vec::new();
    let mut matched_lines: HashSet<usize> = HashSet::new();
    // 已进入结果、但仍需补齐后文的命中下标。
    let mut pending_after: Vec<(usize, usize)> = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { break };
        if line.contains('\0') {
            return Vec::new();
        }
        let matched = matcher.is_match(&line);
        if matched {
            matched_lines.insert(index);
        }
        if context > 0 && !matched {
            for (remaining, match_index) in &mut pending_after {
                if *remaining == 0 {
                    continue;
                }
                matches[*match_index].context.push(GrepLine {
                    line: index + 1,
                    text: truncate_line(&line),
                });
                *remaining -= 1;
            }
            pending_after.retain(|(remaining, _)| *remaining > 0);
        }
        if matched {
            let page_full = *seen >= offset && matches.len() >= limit;
            if page_full {
                if pending_after.is_empty() {
                    break;
                }
            } else if *seen < offset {
                *seen += 1;
            } else {
                *seen += 1;
                let mut context_lines = Vec::new();
                if context > 0 {
                    let first = index.saturating_sub(context);
                    for (neighbour, text) in &recent {
                        if *neighbour >= first && !matched_lines.contains(neighbour) {
                            context_lines.push(GrepLine {
                                line: neighbour + 1,
                                text: text.clone(),
                            });
                        }
                    }
                }
                matches.push(GrepMatch {
                    path: relative.to_string(),
                    line: index + 1,
                    text: truncate_line(&line),
                    context: context_lines,
                });
                if context > 0 {
                    pending_after.push((context, matches.len() - 1));
                }
            }
        }
        if context > 0 {
            recent.push((index, truncate_line(&line)));
            if recent.len() > context {
                recent.remove(0);
            }
        }
        if matches.len() >= limit && pending_after.is_empty() {
            break;
        }
    }
    matches
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
        assert_eq!(outcome.scanned_files, 3);
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
        let found = grep_search(&root, "World", None, false, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line, 1);
        let insensitive =
            grep_search(&root, "world", None, true, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert_eq!(insensitive.matches.len(), 1);
        let missing = grep_search(&root, "nope", None, false, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert!(missing.matches.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_supports_regex_literal_mode_and_invalid_pattern_errors() {
        let root = temp_workspace("grep-regex");
        fs::write(
            root.join("code.txt"),
            "createFileGlobTool\ncreateFileGrepTool\nfoo|bar\n",
        )
        .unwrap();

        let regex = grep_search(
            &root,
            "createFile(Glob|Grep)Tool",
            None,
            false,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert_eq!(regex.matches.len(), 2);

        let literal = grep_search_with_mode(
            &root,
            "foo|bar",
            None,
            false,
            true,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert_eq!(literal.matches.len(), 1);
        let metacharacters = grep_search_with_mode(
            &root,
            "a.+*",
            None,
            false,
            true,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert!(metacharacters.matches.is_empty());
        let invalid = grep_search(&root, "(", None, false, 0, DEFAULT_GREP_LIMIT, None)
            .err()
            .expect("unterminated group must fail");
        assert!(invalid.contains("invalid search regex"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_ignore_case_folds_unicode() {
        let root = temp_workspace("grep-unicode-case");
        // regex 1.13 uses Unicode simple case folding only. U+017F LATIN
        // SMALL LETTER LONG S folds to ASCII `s`; U+0130 LATIN CAPITAL LETTER
        // I WITH DOT ABOVE needs full case folding (`i` + combining dot) and
        // does not match ASCII `i`.
        fs::write(root.join("note.txt"), "\u{017f}tart\n").unwrap();
        let found = grep_search(&root, "s", None, true, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert_eq!(found.matches.len(), 1);
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
        let outcome =
            grep_search(&root, "needle", None, false, 2, DEFAULT_GREP_LIMIT, None).unwrap();
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
        let plain = grep_search(&root, "l0", None, false, 0, DEFAULT_GREP_LIMIT, None).unwrap();
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
        let outcome =
            grep_search(&root, "needle", None, false, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].path, "text.txt");
        let filtered = grep_search(
            &root,
            "needle",
            Some("*.bin"),
            false,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert!(filtered.matches.is_empty());
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/nested.rs"), "needle nested").unwrap();
        let basename_filtered = grep_search(
            &root,
            "needle",
            Some("*.rs"),
            false,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert_eq!(basename_filtered.matches.len(), 1);
        assert_eq!(basename_filtered.matches[0].path, "src/nested.rs");
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

        let grep = grep_search(&root, "needle", None, false, 0, 0, None).unwrap();
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
        let outcome = grep_search(&root, "needle", None, false, 0, 5, None).unwrap();
        assert_eq!(outcome.matches.len(), 5);
        assert!(outcome.truncated);
        let by_file: HashSet<&str> = outcome.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(by_file.contains("a.txt"));
        assert!(by_file.contains("b.txt"));
        assert!(by_file.contains("c.txt"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_resumes_from_offset() {
        let root = temp_workspace("grep-offset");
        fs::write(root.join("a.txt"), "needle one\nneedle two\nneedle three\n").unwrap();
        let first = grep_search(&root, "needle", None, false, 0, 2, None).unwrap();
        assert_eq!(first.matches.len(), 2);
        assert_eq!(first.next_offset, Some(2));
        let second = grep_search(&root, "needle", None, false, 0, 2, first.next_offset).unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].line, 3);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_streams_files_larger_than_eager_read_limit() {
        let root = temp_workspace("grep-large");
        let mut body = "padding line\n".repeat(180_000);
        body.push_str("unique streamed needle\n");
        fs::write(root.join("large.txt"), body).unwrap();
        let outcome = grep_search(
            &root,
            "unique streamed needle",
            None,
            false,
            0,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].line, 180_001);

        let mut contextual = "padding line\n".repeat(180_000);
        contextual.push_str("before\nunique streamed needle\nafter\n");
        fs::write(root.join("large.txt"), contextual).unwrap();
        let with_context = grep_search(
            &root,
            "unique streamed needle",
            None,
            false,
            1,
            DEFAULT_GREP_LIMIT,
            None,
        )
        .unwrap();
        assert_eq!(with_context.matches.len(), 1);
        let context_lines: Vec<usize> = with_context.matches[0]
            .context
            .iter()
            .map(|line| line.line)
            .collect();
        assert_eq!(context_lines, vec![180_001, 180_003]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn grep_rejects_empty_text() {
        let root = temp_workspace("grep-empty");
        assert!(grep_search(&root, "  ", None, false, 0, DEFAULT_GREP_LIMIT, None).is_err());
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

        let grep = grep_search(&root, "needle", None, false, 0, DEFAULT_GREP_LIMIT, None).unwrap();
        assert_eq!(grep.matches.len(), 1);
        assert_eq!(grep.matches[0].path, "src/main.ts");
        assert!(!grep.truncated);

        fs::remove_dir_all(&root).ok();
    }
}
