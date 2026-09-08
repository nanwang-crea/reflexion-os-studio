//! 工作树 Git 状态（untracked 一并列出）与 `--porcelain=v1 -z` 输出解析。

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
            "--porcelain=v1",
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
        }),
        _ => Err(GitError::new(
            "git_failed",
            first_line(&output.stderr).to_string(),
        )),
    }
}

/// 解析 `git status --porcelain=v1 -z` 输出。
/// -z 下换行不再转义（空格/引号/非 ASCII 原样），记录以 \0 分隔；
/// 每条记录为 `XY <路径>`（2 状态字符 + 空格），重命名/复制由两段组成：
/// 第一段为 `XY <新路径>`，第二段为 `<旧路径>`（与普通格式的 old -> new 相反）。
fn parse_status(stdout: &str) -> StatusOutcome {
    let records: Vec<&[u8]> = stdout.split('\0').map(str::as_bytes).collect();
    let mut entries: Vec<StatusEntry> = Vec::new();
    let mut truncated = false;
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES || record.len() < 3 {
            truncated = true;
            break;
        }
        let xy = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let (status, staged) = classify_xy(xy[0], xy[1]);
        let old_path = if matches!(status, "renamed") {
            index += 1;
            let old = records.get(index).copied().unwrap_or_default();
            if old.is_empty() {
                truncated = true;
                break;
            }
            Some(String::from_utf8_lossy(old).into_owned())
        } else {
            None
        };
        entries.push(StatusEntry {
            path,
            old_path,
            status,
            staged,
        });
        index += 1;
    }
    StatusOutcome {
        repo: true,
        entries,
        truncated,
    }
}

/// XY 状态 → 变化类别与 staged 标记（X=索引, Y=工作树）。
fn classify_xy(x: u8, y: u8) -> (&'static str, bool) {
    if x == b'?' || y == b'?' {
        return ("untracked", false);
    }
    let conflict = matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'));
    if conflict {
        return ("conflicted", false);
    }
    if matches!((x, y), (b'R', _) | (_, b'R') | (b'C', _) | (_, b'C')) {
        return ("renamed", x != b' ');
    }
    if x == b'D' || y == b'D' {
        return ("deleted", x == b'D');
    }
    if x == b'A' || y == b'A' {
        return ("added", x == b'A');
    }
    return ("modified", x != b' ');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v1_z_records() {
        // 与实测一致：普通记录 `XY path\0`，重命名两段 `R  new\0old\0`。
        let input = " M a.txt\0 D b.txt\0R  renamed.txt\0c.txt\0A  x.txt\0?? new.txt\0";
        let outcome = parse_status(input);
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.truncated, false);
        let keys: Vec<(&str, &str, bool)> = outcome
            .entries
            .iter()
            .map(|entry| (entry.status, entry.path.as_str(), entry.staged))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("modified", "a.txt", false),
                ("deleted", "b.txt", false),
                ("renamed", "renamed.txt", true),
                ("added", "x.txt", true),
                ("untracked", "new.txt", false),
            ]
        );
        let rename = outcome.entries.get(2).unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("c.txt"));
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
    }

    #[test]
    fn truncates_on_excessive_entries_and_empty_rename_old() {
        let mut input = String::new();
        for _ in 0..(MAX_STATUS_ENTRIES + 1) {
            input.push_str(" M f.txt\0");
        }
        let outcome = parse_status(&input);
        assert_eq!(outcome.entries.len(), MAX_STATUS_ENTRIES);
        assert_eq!(outcome.truncated, true);

        let missing_old = parse_status("R  new.txt\0");
        assert_eq!(missing_old.truncated, true);
    }
}
