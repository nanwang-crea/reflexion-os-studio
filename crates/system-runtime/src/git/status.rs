//! 工作树 Git 状态（untracked 一并列出）与 `--porcelain=v2 --branch -z` 输出解析。

use std::path::Path;

use serde::Serialize;

use super::exec::{first_line, run_git, GitOutput};
use super::service::GitError;

/// 变更条目上限：仓库特别脏时防一次吃掉资源，超出标记 truncated。
const MAX_STATUS_ENTRIES: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub repo: bool,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

/// 非仓库:status 报 fatal(exit 128,小写),diff 报 warning+usage(exit 129,
/// 大写 Not),统一按 stderr 内容识别,不依赖退出码。
pub(super) fn is_not_a_repo(output: &GitOutput) -> bool {
    output
        .stderr
        .to_lowercase()
        .contains("not a git repository")
}

pub(super) fn status(workspace_root: &Path) -> Result<StatusOutcome, GitError> {
    let output = run_git(
        workspace_root,
        &[
            "--no-pager",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git status timed out".to_string(),
        ));
    }
    match output.exit_code {
        Some(0) => Ok(parse_status(&output.stdout)),
        _ if is_not_a_repo(&output) => Ok(StatusOutcome {
            repo: false,
            entries: Vec::new(),
            truncated: false,
            branch: None,
            upstream: None,
            ahead: None,
            behind: None,
        }),
        _ => Err(GitError::new(
            "git_failed",
            first_line(&output.stderr).to_string(),
        )),
    }
}

/// 解析 `git status --porcelain=v2 --branch -z` 输出。
/// -z 下换行不再转义（空格/引号/非 ASCII 原样），记录以 \0 分隔；
/// 头记录 `# branch.head <name>` / `# branch.upstream <u>` /
/// `# branch.ab +N -M`（ahead=+N, behind=-M）；条目 `1|2 …path`、`2` 的
/// origPath 为下一条记录、`? …path`、`u …path`（冲突按 v1 同类逻辑处理为 conflicted）。
fn parse_status(stdout: &str) -> StatusOutcome {
    let mut entries: Vec<StatusEntry> = Vec::new();
    let mut branch: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut ahead: Option<u64> = None;
    let mut behind: Option<u64> = None;
    let mut truncated = false;
    let mut records = stdout.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            branch = if rest == "(detached)" {
                None
            } else {
                Some(rest.to_string())
            };
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.ab ") {
            let mut parts = rest.split(' ');
            ahead = parts
                .next()
                .and_then(|value| value.strip_prefix('+'))
                .and_then(|value| value.parse().ok());
            behind = parts
                .next()
                .and_then(|value| value.strip_prefix('-'))
                .and_then(|value| value.parse().ok());
            continue;
        }
        if record.starts_with("# ") || record.starts_with("! ") {
            continue; // 其它头/ignored：忽略
        }
        // untracked 分支必须在 XY 提取之前：`? <单字符名>`（如 `? a`）只有 3 字节，
        // 先取 get(2)/get(3) 会误判 truncated 并丢弃后续全部条目；`?` 路径不用 x/y。
        if record.starts_with("? ") {
            let (status, staged) = classify_xy(b'?', b'?');
            entries.push(StatusEntry {
                path: record[2..].to_string(),
                old_path: None,
                status,
                staged,
            });
            continue;
        }
        let (x, y) = match (record.as_bytes().get(2), record.as_bytes().get(3)) {
            (Some(a), Some(b)) => (*a, *b),
            _ => {
                truncated = true;
                break;
            }
        };
        let kind = record.as_bytes()[0];
        // 1/2/u 条目：path 在第 8/9/10 个空格后（v2 定长字段数，实测 git 输出核对）。
        let fields_before = match kind {
            b'1' => 8,
            b'2' => 9,
            b'u' => 10,
            _ => {
                truncated = true;
                break;
            }
        };
        let path = match record.splitn(fields_before + 1, ' ').nth(fields_before) {
            Some(path) => path.to_string(),
            None => {
                truncated = true;
                break;
            }
        };
        let old_path = if kind == b'2' {
            match records.next() {
                Some(old) if !old.is_empty() => Some(old.to_string()),
                _ => {
                    truncated = true;
                    None
                }
            }
        } else {
            None
        };
        let (status, staged) = classify_xy(x, y);
        entries.push(StatusEntry {
            path,
            old_path,
            status,
            staged,
        });
    }
    StatusOutcome {
        repo: true,
        entries,
        truncated,
        branch,
        upstream,
        ahead,
        behind,
    }
}

/// XY 状态 → 变化类别与 staged 标记（X=索引, Y=工作树）。
/// v2 的"未变"占位符是 `.`（v1 是空格），两者都按未变处理。
fn classify_xy(x: u8, y: u8) -> (&'static str, bool) {
    let changed = |value: u8| value != b'.' && value != b' ';
    if x == b'?' || y == b'?' {
        return ("untracked", false);
    }
    let conflict = matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'));
    if conflict {
        return ("conflicted", false);
    }
    if matches!((x, y), (b'R', _) | (_, b'R') | (b'C', _) | (_, b'C')) {
        return ("renamed", changed(x));
    }
    if x == b'D' || y == b'D' {
        return ("deleted", x == b'D');
    }
    if x == b'A' || y == b'A' {
        return ("added", x == b'A');
    }
    ("modified", changed(x))
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    #[test]
    fn parses_porcelain_v2_z_records_and_branch_header() {
        // 与实测一致：头记录先行；`1` path 在第 8 空格后，`2` 带 <X><score>
        // 共第 9 空格后且 origPath 为下一条记录，`? path` 直接取第 2 字节起。
        let input = "# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\01 M. N... 100644 100644 100644 aabbccd aabbccd f.txt\02 R. N... 100644 100644 100644 aabbccd aabbccd R100 new.txt\0old.txt\0? n.txt\0? a\0";
        let outcome = parse_status(input);
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.truncated, false);
        assert_eq!(outcome.branch.as_deref(), Some("main"));
        assert_eq!(outcome.upstream.as_deref(), Some("origin/main"));
        assert_eq!(outcome.ahead, Some(2));
        assert_eq!(outcome.behind, Some(1));
        let keys: Vec<(&str, &str, bool)> = outcome
            .entries
            .iter()
            .map(|entry| (entry.status, entry.path.as_str(), entry.staged))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("modified", "f.txt", true),
                ("renamed", "new.txt", true),
                ("untracked", "n.txt", false),
                ("untracked", "a", false),
            ]
        );
        let rename = outcome.entries.get(1).unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn detached_head_reports_branch_none() {
        let outcome = parse_status("# branch.head (detached)\0? n.txt\0");
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.branch, None);
        assert_eq!(outcome.upstream, None);
        assert_eq!(outcome.ahead, None);
        assert_eq!(outcome.behind, None);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].status, "untracked");
    }

    #[test]
    fn parses_unmerged_entry_as_conflicted() {
        // u 条目：4 组 mode + 3 个 stage 哈希，path 在第 10 空格后；AA 按 v1 同类逻辑归为 conflicted。
        let input = "u AA N... 000000 100644 100644 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 c.txt\0";
        let outcome = parse_status(input);
        assert_eq!(outcome.truncated, false);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].status, "conflicted");
        assert_eq!(outcome.entries[0].path, "c.txt");
    }

    #[test]
    fn classifies_conflict_and_index_states() {
        assert_eq!(classify_xy(b'U', b'U'), ("conflicted", false));
        assert_eq!(classify_xy(b'A', b' '), ("added", true));
        assert_eq!(classify_xy(b' ', b'A'), ("added", false));
        assert_eq!(classify_xy(b'M', b' '), ("modified", true));
        assert_eq!(classify_xy(b' ', b'M'), ("modified", false));
        assert_eq!(classify_xy(b'D', b' '), ("deleted", true));
        assert_eq!(classify_xy(b'?', b'?'), ("untracked", false));
        // porcelain v2 用 '.' 作未变占位符（unstage 后的 `1 .M` 不得判为 staged）。
        assert_eq!(classify_xy(b'.', b'M'), ("modified", false));
        assert_eq!(classify_xy(b'M', b'.'), ("modified", true));
        assert_eq!(classify_xy(b'.', b'R'), ("renamed", false));
    }

    #[test]
    fn truncates_on_excessive_entries_and_empty_rename_old() {
        let mut input = String::new();
        for _ in 0..(MAX_STATUS_ENTRIES + 1) {
            input.push_str("1 M. N... 100644 100644 100644 aabbccd aabbccd f.txt\0");
        }
        let outcome = parse_status(&input);
        assert_eq!(outcome.entries.len(), MAX_STATUS_ENTRIES);
        assert_eq!(outcome.truncated, true);

        let missing_old =
            parse_status("2 R. N... 100644 100644 100644 aabbccd aabbccd R100 new.txt\0");
        assert_eq!(missing_old.truncated, true);
    }

    #[test]
    fn status_reports_branch_and_none_upstream_against_real_repo() {
        let Some(root) = testutil::temp_repo_with_commit("v2status") else {
            return;
        };
        let expected = testutil::default_branch(&root);
        let outcome = status(&root).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.branch.as_deref(), Some(expected.as_str()));
        assert_eq!(outcome.upstream, None);
        assert_eq!(outcome.ahead, None);
        assert_eq!(outcome.behind, None);
        std::fs::remove_dir_all(&root).ok();
    }
}
