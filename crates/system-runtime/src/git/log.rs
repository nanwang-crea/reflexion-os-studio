//! 提交历史读取：git log 元信息解析 + 单 commit 改动文件（name-status -z）。
//! 只读；hash 由上层预校验为十六进制，仍走 --no-pager 与超时档（GIT_RO）。
//! log 分页多取一条判 hasMore；stdout 受 exec 层管道上限约束，正常页大小
//! （limit）远不足以触顶，残行按解析失败逐行跳过。

use std::path::Path;

use serde::Serialize;

use super::exec::{first_line, run_git};
use super::service::GitError;

/// 空树 OID：root commit（无父）diff 的左端，规避 <hash>^ 不存在。
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// fields 用 %x1f（单元分隔符）连接，顺序：hash, shortHash, authorTs,
/// authorName, parents, subject。subject 恒为末段，若其中混入 %x1f（实测
/// git **不**清洗 ident 里的控制字符，伪造身份可注入）则由解析侧回收剩余
/// 段，且 LogEntry 构造前统一剥离 <0x20 字符，控制字节不出边界。
/// 记录间用 \n。
const LOG_FORMAT: &str = "%H%x1f%h%x1f%at%x1f%an%x1f%P%x1f%s";
const FIELD_SEP: char = '\u{1f}';

/// 防御性清洗：剥离 <0x20 控制字符（伪造身份注入 %x1f 时不污染 JSON 出参）。
fn strip_control_chars(value: &str) -> String {
    value.chars().filter(|c| *c >= '\u{20}').collect::<String>()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub short_hash: String,
    pub timestamp_ms: u64,
    pub author_name: String,
    pub is_merge: bool,
    pub subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOutcome {
    pub repo: bool,
    pub commits: Vec<LogEntry>,
    pub has_more: bool,
}

/// 提交历史（当前 HEAD，最新在前，含 merge）。非仓库 → repo=false；
/// 空仓库（无任何提交）→ repo=true + 空列表。
pub fn log(root: &Path, skip: usize, limit: usize) -> Result<LogOutcome, GitError> {
    let fetch = limit + 1; // 多取一条判 hasMore
    let output = run_git(
        root,
        &[
            "--no-pager",
            "log",
            &format!("--pretty=format:{LOG_FORMAT}"),
            &format!("--skip={skip}"),
            &format!("--max-count={fetch}"),
        ],
    )?;
    // 不过滤 merge：isMerge 由 %P 父数判，需展示。
    if output.timed_out {
        return Err(GitError::new("git_failed", "git log timed out".to_string()));
    }
    match output.exit_code {
        Some(0) => {}
        _ if super::status::is_not_a_repo(&output) => {
            return Ok(LogOutcome {
                repo: false,
                commits: Vec::new(),
                has_more: false,
            });
        }
        // 空仓库：log 报 "does not have any commits yet"（exit 128，LC_ALL=C 固定英文）。
        _ if output
            .stderr
            .to_lowercase()
            .contains("does not have any commits yet") =>
        {
            return Ok(LogOutcome {
                repo: true,
                commits: Vec::new(),
                has_more: false,
            });
        }
        _ => {
            return Err(GitError::new("git_failed", first_line(&output.stderr)));
        }
    }
    let mut commits = parse_log_lines(&output.stdout);
    let has_more = commits.len() > limit;
    if has_more {
        commits.truncate(limit);
    }
    Ok(LogOutcome {
        repo: true,
        commits,
        has_more,
    })
}

/// 逐行解析 pretty 输出；字段不足 6 段的残行（如管道截断的最后一行）跳过。
fn parse_log_lines(stdout: &str) -> Vec<LogEntry> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split(FIELD_SEP);
        let (Some(hash), Some(short_hash), Some(at), Some(author), Some(parents), Some(subject)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        // subject 为末段：极端情况下回收其中混入的分隔符段。
        let mut subject = subject.to_string();
        for extra in fields {
            subject.push(FIELD_SEP);
            subject.push_str(extra);
        }
        let timestamp_ms = at.trim().parse::<u64>().unwrap_or(0) * 1000;
        out.push(LogEntry {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            timestamp_ms,
            author_name: strip_control_chars(author),
            is_merge: parents.split_whitespace().count() > 1,
            subject: strip_control_chars(&subject),
        });
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
}

/// 单 commit 相对父提交的改动文件。父：`<hash>^`（存在时）否则 EMPTY_TREE
/// （root）；merge commit 的 `<hash>^` 即第一父，天然按首父归一。
/// `-c diff.renames=true`：重命名识别不依赖用户全局配置（false 时输出
/// 退化为 D+A，历史面板会丢 oldPath）。
pub fn commit_files(root: &Path, hash: &str) -> Result<Vec<ChangedFile>, GitError> {
    let parent = format!("{hash}^");
    let has_parent = run_git(
        root,
        &["--no-pager", "rev-parse", "--verify", "--quiet", &parent],
    )
    .map(|output| output.exit_code == Some(0))
    .unwrap_or(false);
    let left = if has_parent {
        parent.as_str()
    } else {
        EMPTY_TREE
    };
    let output = run_git(
        root,
        &[
            "-c",
            "diff.renames=true",
            "--no-pager",
            "diff",
            "--name-status",
            "-z",
            left,
            hash,
        ],
    )?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git diff timed out".to_string(),
        ));
    }
    if output.exit_code != Some(0) {
        return Err(GitError::new("git_failed", first_line(&output.stderr)));
    }
    Ok(parse_name_status_z(&output.stdout))
}

/// name-status -z：NUL 分隔字段流。普通 `M\0path\0`；重命名/复制
/// `R100\0old\0new\0`。尾部不完整记录（管道截断）直接丢弃。
fn parse_name_status_z(stdout: &str) -> Vec<ChangedFile> {
    let toks: Vec<&str> = stdout.split('\0').filter(|t| !t.is_empty()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let status_tok = toks[i];
        let letter = match status_tok.chars().next() {
            Some(c) => c,
            None => break,
        };
        let two_path = matches!(letter, 'R' | 'C');
        let width = if two_path { 3 } else { 2 };
        if i + width > toks.len() {
            break; // 记录不完整：截断尾部，丢弃
        }
        if two_path {
            out.push(ChangedFile {
                path: toks[i + 2].to_string(),
                old_path: Some(toks[i + 1].to_string()),
                status: classify_name_status(letter),
            });
        } else {
            out.push(ChangedFile {
                path: toks[i + 1].to_string(),
                old_path: None,
                status: classify_name_status(letter),
            });
        }
        i += width;
    }
    out
}

fn classify_name_status(letter: char) -> &'static str {
    match letter {
        'A' => "added",
        'D' => "deleted",
        'R' | 'C' => "renamed",
        _ => "modified", // M/T/U 一律归 modified（历史展示无需细分冲突/typechange）
    }
}

#[cfg(test)]
mod tests {
    use super::super::exec::find_git_executable;
    use super::super::testutil;
    use super::*;

    /// 取某个 ref 的完整 hash（rev-parse），失败即 panic（fixture 步骤）。
    fn head_hash(root: &Path, rev: &str) -> String {
        let output = run_git(root, &["--no-pager", "rev-parse", rev]).unwrap();
        assert_eq!(output.exit_code, Some(0), "rev-parse {rev}");
        output.stdout.trim().to_string()
    }

    fn file_triples(files: &[ChangedFile]) -> Vec<(&str, Option<&str>, &str)> {
        let mut got: Vec<(&str, Option<&str>, &str)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.old_path.as_deref(), f.status))
            .collect();
        got.sort();
        got
    }

    /// init → second → (feature: add y) → merge --no-ff，四提交仓库。
    fn repo_with_merge(tag: &str) -> Option<std::path::PathBuf> {
        let Some(root) = testutil::temp_repo_with_commit(tag) else {
            return None;
        };
        let main = testutil::default_branch(&root);
        testutil::write(&root, "x.txt", b"x\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "second: add x"]
        ));
        assert!(testutil::git_cli(
            &root,
            &["checkout", "-q", "-b", "feature"]
        ));
        testutil::write(&root, "y.txt", b"y\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "feature: add y"]
        ));
        assert!(testutil::git_cli(&root, &["checkout", "-q", &main]));
        assert!(testutil::git_cli(
            &root,
            &["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]
        ));
        Some(root)
    }

    #[test]
    fn log_parses_subjects_authors_and_merge_flag() {
        // 固定夹具：4 提交，merge 最新、init 最老（时间戳可能同秒，中间
        // 两条的相对顺序不做断言，只锁首尾 + 集合）。
        let Some(root) = repo_with_merge("logmerge") else {
            return;
        };
        let outcome = log(&root, 0, 10).unwrap();
        assert!(outcome.repo);
        assert!(!outcome.has_more);
        assert_eq!(outcome.commits.len(), 4);
        let pairs: Vec<(&str, bool)> = outcome
            .commits
            .iter()
            .map(|c| (c.subject.as_str(), c.is_merge))
            .collect();
        assert_eq!(pairs[0], ("merge feature", true));
        assert_eq!(*pairs.last().unwrap(), ("init", false));
        let mut sorted = pairs.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec![
                ("feature: add y", false),
                ("init", false),
                ("merge feature", true),
                ("second: add x", false),
            ]
        );
        for entry in &outcome.commits {
            assert_eq!(entry.author_name, "t"); // testutil env 设定
            assert!(entry.timestamp_ms > 0);
            assert_eq!(entry.hash.len(), 40);
            assert!(entry.hash.starts_with(&entry.short_hash));
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_pagination_slices_and_flags_has_more() {
        let Some(root) = repo_with_merge("logpage") else {
            return;
        };
        let full = log(&root, 0, 10).unwrap();
        let first = log(&root, 0, 2).unwrap();
        assert_eq!(first.commits.len(), 2);
        assert!(first.has_more);
        let second = log(&root, 2, 2).unwrap();
        assert_eq!(second.commits.len(), 2);
        assert!(!second.has_more);
        // 页切片与全量一致：连续、无重叠、无缺口。
        assert_eq!(first.commits[0].hash, full.commits[0].hash);
        assert_eq!(first.commits[1].hash, full.commits[1].hash);
        assert_eq!(second.commits[0].hash, full.commits[2].hash);
        assert_eq!(second.commits[1].hash, full.commits[3].hash);
        let beyond = log(&root, 4, 5).unwrap();
        assert!(beyond.commits.is_empty());
        assert!(!beyond.has_more);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_subject_preserves_spaces_unicode_and_empty_message() {
        let Some(root) = testutil::temp_repo_with_commit("logsubj") else {
            return;
        };
        assert!(testutil::git_cli(
            &root,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "feat: 支持中文 subject   with spaces"
            ]
        ));
        assert!(testutil::git_cli(
            &root,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "--allow-empty-message",
                "-m",
                ""
            ]
        ));
        let outcome = log(&root, 0, 10).unwrap();
        assert_eq!(outcome.commits[0].subject, "");
        assert_eq!(
            outcome.commits[1].subject,
            "feat: 支持中文 subject   with spaces"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_strips_control_chars_from_crafted_author_identity() {
        // 实测 git **不**清洗 %an 里的控制字符（\x1f 原样透传）：伪造身份注入
        // FIELD_SEP 会造成段位移（author 截到首段）。LogEntry 出参必须无 <0x20
        // 字节，且 hash/timestamp/is_merge 不因位移而误报（本夹具为单父提交）。
        let Some(root) = testutil::temp_repo_with_commit("logctrl") else {
            return;
        };
        testutil::write(&root, "seed.txt", b"seed v2\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        let executable = find_git_executable().expect("git executable");
        let status = std::process::Command::new(executable)
            .current_dir(&root)
            .args(["commit", "-q", "-m", "crafted identity"])
            .env("GIT_AUTHOR_NAME", "Gi\u{1f}t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("LC_ALL", "C")
            .status()
            .expect("spawn git commit");
        assert!(status.success(), "crafted fixture commit failed");
        let outcome = log(&root, 0, 10).unwrap();
        assert_eq!(outcome.commits.len(), 2);
        let crafted = &outcome.commits[0];
        assert!(crafted.author_name.chars().all(|c| c >= '\u{20}'));
        assert!(crafted.subject.contains("crafted identity"));
        assert!(crafted.subject.chars().all(|c| c >= '\u{20}'));
        assert!(!crafted.is_merge);
        assert_eq!(crafted.hash.len(), 40);
        // 正常提交的解析不受影响。
        assert_eq!(outcome.commits[1].author_name, "t");
        assert_eq!(outcome.commits[1].subject, "init");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_files_lists_changes_and_detects_rename() {
        let Some(root) = testutil::temp_repo_with_commit("cfiles") else {
            return;
        };
        let main = testutil::default_branch(&root);
        // 提交 2：新增 extra.txt + 修改 seed.txt。
        testutil::write(&root, "extra.txt", b"extra\n");
        testutil::write(&root, "seed.txt", b"seed v2\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "add extra, tweak seed"]
        ));
        let second = head_hash(&root, "HEAD");
        assert_eq!(
            file_triples(&commit_files(&root, &second).unwrap()),
            vec![("extra.txt", None, "added"), ("seed.txt", None, "modified"),]
        );
        // 提交 3：git mv extra.txt → moved.txt（对首父呈现 R100）。
        assert!(testutil::git_cli(&root, &["mv", "extra.txt", "moved.txt"]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "rename extra"]
        ));
        let third = head_hash(&root, "HEAD");
        assert_eq!(
            file_triples(&commit_files(&root, &third).unwrap()),
            vec![("moved.txt", Some("extra.txt"), "renamed")]
        );
        // merge 提交：commit_files 取首父 diff（side 的 f.txt 相对首父为新增）。
        assert!(testutil::git_cli(&root, &["checkout", "-q", "-b", "side"]));
        testutil::write(&root, "f.txt", b"f\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "side: add f"]
        ));
        assert!(testutil::git_cli(&root, &["checkout", "-q", &main]));
        assert!(testutil::git_cli(
            &root,
            &["merge", "--no-ff", "-q", "-m", "merge side", "side"]
        ));
        let merge = head_hash(&root, "HEAD");
        assert_eq!(
            file_triples(&commit_files(&root, &merge).unwrap()),
            vec![("f.txt", None, "added")]
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_files_root_commit_diffs_against_empty_tree() {
        let Some(root) = testutil::temp_repo_with_commit("croot") else {
            return;
        };
        let init = head_hash(&root, "HEAD"); // 单提交仓库：HEAD 即 root
        assert_eq!(
            file_triples(&commit_files(&root, &init).unwrap()),
            vec![("seed.txt", None, "added")]
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_empty_repo_reports_repo_true() {
        let Some(root) = testutil::temp_repo("logempty") else {
            return;
        };
        let outcome = log(&root, 0, 10).unwrap();
        assert!(outcome.repo);
        assert!(outcome.commits.is_empty());
        assert!(!outcome.has_more);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_non_repo_reports_repo_false() {
        let root = testutil::temp_workspace("lognonrepo");
        if find_git_executable().is_none() {
            eprintln!("skip: git executable not found");
            return;
        }
        let outcome = log(&root, 0, 10).unwrap();
        assert!(!outcome.repo);
        assert!(outcome.commits.is_empty());
        assert!(!outcome.has_more);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn name_status_z_rename_maps_old_and_new_path() {
        let files = parse_name_status_z("R100\0old.txt\0new.txt\0M\0other.txt\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[1].path, "other.txt");
        assert_eq!(files[1].old_path, None);
        assert_eq!(files[1].status, "modified");
    }

    #[test]
    fn name_status_z_classifies_copy_and_tolerates_truncated_tail() {
        // C 复制与 R 同样三 token，归 renamed；T/D 归类正确。
        let files = parse_name_status_z("C75\0src.txt\0dst.txt\0T\0type.txt\0D\0gone.txt\0");
        assert_eq!(
            file_triples(&files),
            vec![
                ("dst.txt", Some("src.txt"), "renamed"),
                ("gone.txt", None, "deleted"),
                ("type.txt", None, "modified"),
            ]
        );
        // 尾部不完整记录丢弃。
        assert!(parse_name_status_z("R100\0old.txt\0").is_empty());
        assert!(parse_name_status_z("M").is_empty());
        let files = parse_name_status_z("A\0p.txt\0D");
        assert_eq!(file_triples(&files), vec![("p.txt", None, "added")]);
    }

    #[test]
    fn parse_log_lines_joins_extra_segments_strips_controls_and_skips_malformed() {
        // subject 段含分隔符 → 回收剩余段，但 <0x20 控制字符在构造期剥离；
        // 字段不足的行跳过；空 subject 合法。
        let lines = "abc\u{1f}abc\u{1f}1700000000\u{1f}t\u{1f}\u{1f}a\u{1f}b\n\
                     short\u{1f}line\n\
                     h2\u{1f}h2\u{1f}0\u{1f}t\u{1f}p1 p2\u{1f}\n";
        let entries = parse_log_lines(lines);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "ab");
        assert_eq!(entries[0].timestamp_ms, 1700000000 * 1000);
        assert!(!entries[0].is_merge);
        assert_eq!(entries[1].subject, "");
        assert!(entries[1].is_merge);
        assert_eq!(entries[1].timestamp_ms, 0);
    }
}
