//! 工作区路径 enforcement：deny-by-default 的硬边界。
//! 拒绝绝对路径、`..`、路径前缀与符号链接逃逸；所有目标必须落在
//! 规范化后的 workspace root 之内。
use std::path::{Component, Path, PathBuf};

pub fn resolve_in_workspace(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    for component in relative_path.components() {
        match component {
            Component::ParentDir => return Err("'..' is not allowed".to_string()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("path prefixes are not allowed".to_string())
            }
            Component::CurDir => continue,
            Component::Normal(_) => {}
        }
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("workspace root invalid: {error}"))?;
    let target = canonical_root.join(relative_path);
    resolve_with_symlink_boundary(&canonical_root, &target)
}

/// 已存在目标直接 canonicalize（符号链接边界）；
/// 尚不存在的目标向上找最近存在的祖先做 canonicalize，再把完整剩余路径拼回，
/// 不拍平中间组件（`a/b/c.txt` 中 `a` 不存在时必须保持 `a/b/c.txt` 形状）。
fn resolve_with_symlink_boundary(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.exists() {
        let canonical = target
            .canonicalize()
            .map_err(|error| format!("path resolve failed: {error}"))?;
        return ensure_inside(root, canonical);
    }
    let mut ancestor = target.parent();
    while let Some(dir) = ancestor {
        if dir.exists() {
            let canonical = dir
                .canonicalize()
                .map_err(|error| format!("path resolve failed: {error}"))?;
            let canonical = ensure_inside(root, canonical)?;
            let tail = target
                .strip_prefix(dir)
                .map_err(|error| format!("invalid path: {error}"))?;
            // 拼回 canonical 化后的祖先，而不是 workspace 根：
            // 根下更深的已存在目录（如 a/）不能被拍平，否则 `a/b/c.txt`
            // 会被解析成根下的 `b/c.txt`。
            return Ok(canonical.join(tail));
        }
        ancestor = dir.parent();
    }
    Err("workspace root not found".to_string())
}

fn ensure_inside(root: &Path, canonical: PathBuf) -> Result<PathBuf, String> {
    if !canonical.starts_with(root) {
        return Err("path escapes workspace".to_string());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reflexion-paths-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_empty_absolute_and_parent_traversal() {
        let root = temp_workspace("traversal");
        assert!(resolve_in_workspace(&root, "").is_err());
        assert!(resolve_in_workspace(&root, "   ").is_err());
        assert!(resolve_in_workspace(&root, "/etc/passwd").is_err());
        assert!(resolve_in_workspace(&root, "../outside").is_err());
        assert!(resolve_in_workspace(&root, "a/../../outside").is_err());
        assert!(resolve_in_workspace(&root, "a/./b.txt").is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolves_existing_file_inside_workspace() {
        let root = temp_workspace("existing");
        fs::write(root.join("note.txt"), "hello").unwrap();
        let resolved = resolve_in_workspace(&root, "note.txt").unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap().join("note.txt"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_symlink_escape_for_existing_target() {
        let root = temp_workspace("symlink-existing");
        let outside = temp_workspace("symlink-outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside.join("secret.txt"), root.join("link.txt")).unwrap();
            assert!(resolve_in_workspace(&root, "link.txt").is_err());
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn rejects_symlinked_directory_in_uncreated_path() {
        let root = temp_workspace("symlink-dir");
        let outside = temp_workspace("symlink-dir-outside");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("jump")).unwrap();
            // jump/new.txt 不存在，但最近存在祖先 `jump` 规范化后在 workspace 外。
            assert!(resolve_in_workspace(&root, "jump/new.txt").is_err());
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn resolves_uncreated_path_via_existing_ancestor() {
        let root = temp_workspace("uncreated");
        let resolved =
            resolve_in_workspace(&root, "a/b/c.txt").expect("deep new path should resolve");
        assert!(resolved.starts_with(root.canonicalize().unwrap()));
        assert!(resolved.ends_with("c.txt"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn keeps_intermediate_segments_when_deeper_ancestor_exists() {
        let root = temp_workspace("deep-ancestor");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/dup.txt"), "x").unwrap();
        let resolved = resolve_in_workspace(&root, "a/b/c.txt").expect("path under existing dir");
        assert_eq!(resolved, root.canonicalize().unwrap().join("a/b/c.txt"));
        fs::remove_dir_all(&root).ok();
    }
}
