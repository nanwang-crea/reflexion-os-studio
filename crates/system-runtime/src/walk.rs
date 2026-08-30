//! Workspace 目录遍历：glob/grep/递归 list 共用。
//! 安全边界：不跟随任何符号链接（目录与文件均跳过，杜绝逃逸）；
//! 深度与文件数双重上限，超限置 truncated 而不是无限扫描。
use std::fs;
use std::path::Path;

use serde::Serialize;

pub const MAX_WALK_FILES: usize = 20_000;
const MAX_WALK_DEPTH: usize = 32;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 相对 workspace root（或遍历起点）的完整路径，含文件名。
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
}

pub struct Walked {
    pub files: Vec<FileEntry>,
    /// 文件数/深度达到上限：结果不完整，调用方应如实告知模型。
    pub truncated: bool,
}

/// 从 `start_dir`（对应相对名 `start_relative`，根目录传 ""）递归收集文件。
pub fn walk_files(start_dir: &Path, start_relative: &str) -> Walked {
    let mut state = WalkState {
        files: Vec::new(),
        truncated: false,
    };
    walk_dir(start_dir, start_relative, 0, &mut state);
    state.files.sort_by(|a, b| a.path.cmp(&b.path));
    Walked {
        files: state.files,
        truncated: state.truncated,
    }
}

struct WalkState {
    files: Vec<FileEntry>,
    truncated: bool,
}

fn walk_dir(dir: &Path, relative: &str, depth: usize, state: &mut WalkState) {
    if depth > MAX_WALK_DEPTH || state.files.len() >= MAX_WALK_FILES {
        state.truncated = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if state.files.len() >= MAX_WALK_FILES {
            state.truncated = true;
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 符号链接一律跳过：目录防逃逸，文件防读到 workspace 外内容。
        if file_type.is_symlink() {
            continue;
        }
        let child_relative = if relative.is_empty() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            format!("{relative}/{}", entry.file_name().to_string_lossy())
        };
        if file_type.is_dir() {
            walk_dir(&entry.path(), &child_relative, depth + 1, state);
        } else if file_type.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            state.files.push(FileEntry {
                path: child_relative,
                kind: "file".to_string(),
                size_bytes: size,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reflexion-walk-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn collects_nested_files_with_relative_paths() {
        let root = temp_workspace("nested");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("src/b.txt"), "bb").unwrap();
        fs::write(root.join("src/deep/c.txt"), "ccc").unwrap();
        let walked = walk_files(&root, "");
        assert_eq!(walked.files.len(), 3);
        assert_eq!(walked.files[0].path, "a.txt");
        assert_eq!(walked.files[1].path, "src/b.txt");
        assert_eq!(walked.files[2].path, "src/deep/c.txt");
        assert_eq!(walked.files[2].size_bytes, 3);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skips_symlinks_instead_of_following() {
        let root = temp_workspace("symlink");
        let outside = temp_workspace("symlink-outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("jump")).unwrap();
            let walked = walk_files(&root, "");
            assert!(walked.files.is_empty());
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
