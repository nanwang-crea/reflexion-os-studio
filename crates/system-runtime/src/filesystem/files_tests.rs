use super::*;
use std::path::PathBuf;

fn temp_workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("reflexion-files-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn list_native_nested_paths_returns_portable_relative_names() {
    let root = temp_workspace("native-list");
    fs::create_dir_all(root.join("目录").join("子目录")).unwrap();
    fs::write(root.join("目录").join("子目录").join("file.txt"), "fixture").unwrap();
    let relative = std::path::PathBuf::from("目录").join("子目录");
    let page = list(&root, relative.to_str().unwrap(), false, None, None).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].path, "目录/子目录/file.txt");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn read_write_roundtrip_inside_workspace() {
    let root = temp_workspace("roundtrip");
    let outcome = write(&root, "docs/note.txt", "你好工作区", None).unwrap();
    assert!(outcome.created);
    let read = read(&root, "docs/note.txt", None, None).unwrap();
    assert_eq!(read.content, "你好工作区");
    assert_eq!(read.total_lines, 1);
    assert_eq!(read.modified_ms, outcome.modified_ms);
    // 读取响应携带完整 revision，且与写入方返回的一致（同一内容）。
    assert_eq!(read.content_sha256, outcome.revision.sha256);
    assert_eq!(read.size_bytes, outcome.revision.size_bytes);
    let entries = list(&root, ".", false, None, None).unwrap();
    assert_eq!(entries.entries[0].path, "docs");
    assert_eq!(entries.entries[0].kind, "dir");
    assert_eq!(entries.returned_count, 1);
    assert!(!entries.truncated);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn write_requires_fresh_revision_for_existing_files() {
    let root = temp_workspace("write-token");
    let created = write(&root, "a.txt", "v1", None).unwrap();
    assert!(created.created);
    // 未携带 revision 的覆盖写被拒绝。
    assert!(write(&root, "a.txt", "v2", None).is_err());
    // 陈旧 revision（mtime 不一致）被拒绝。
    let stale = Revision {
        modified_ms: created.revision.modified_ms + 1,
        size_bytes: created.revision.size_bytes,
        sha256: created.revision.sha256.clone(),
    };
    assert!(write(&root, "a.txt", "v2", Some(stale)).is_err());
    // 完整读取获得 revision 后成功覆盖；返回写入后的新 revision。
    let fresh = read(&root, "a.txt", None, None).unwrap();
    let token = Revision {
        modified_ms: fresh.modified_ms,
        size_bytes: fresh.size_bytes,
        sha256: fresh.content_sha256.clone(),
    };
    let overwritten = write(&root, "a.txt", "v2", Some(token)).unwrap();
    assert!(!overwritten.created);
    assert!(overwritten.modified_ms >= fresh.modified_ms);
    assert_eq!(
        overwritten.revision.sha256,
        crate::filesystem::sha256::hex_digest(b"v2")
    );
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "v2");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn write_rejects_revision_field_mismatches() {
    let root = temp_workspace("write-revision");
    write(&root, "a.txt", "original", None).unwrap();
    let fresh = read(&root, "a.txt", None, None).unwrap();
    let base = Revision {
        modified_ms: fresh.modified_ms,
        size_bytes: fresh.size_bytes,
        sha256: fresh.content_sha256,
    };
    // 同 mtime 但 size 不一致（外部追加修改的形态）。
    let size_mismatch = Revision {
        size_bytes: base.size_bytes + 1,
        ..base.clone()
    };
    assert!(write(&root, "a.txt", "v2", Some(size_mismatch)).is_err());
    // mtime/size 一致但 sha256 不一致（同毫秒内内容漂移的兜底）。
    let sha_mismatch = Revision {
        sha256: "0".repeat(64),
        ..base.clone()
    };
    assert!(write(&root, "a.txt", "v2", Some(sha_mismatch)).is_err());
    // 内容未被外部改动：正确 revision 覆盖成功。
    assert!(write(&root, "a.txt", "v2", Some(base)).is_ok());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn read_returns_revision_and_roundtrips_through_write() {
    let root = temp_workspace("revision");
    write(&root, "a.txt", "line1\nline2\n", None).unwrap();
    let full = read(&root, "a.txt", None, None).unwrap();
    assert_eq!(
        full.content_sha256,
        crate::filesystem::sha256::hex_digest(b"line1\nline2\n")
    );
    // 未触达行数上限 → 完整读取。
    assert!(full.read_complete);
    let paged = read(&root, "a.txt", None, Some(1)).unwrap();
    // 触达 limit 的窗口不是完整读取。
    assert!(!paged.read_complete);
    assert_eq!(paged.content_sha256, full.content_sha256);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn binary_preview_reads_bytes_and_keeps_workspace_boundary() {
    let root = temp_workspace("binary-preview");
    fs::write(root.join("image.bin"), [0_u8, 1, 2, 255]).unwrap();
    assert_eq!(
        read_binary(&root, "image.bin").unwrap(),
        vec![0_u8, 1, 2, 255]
    );
    assert!(read_binary(&root, "../outside.bin").is_err());
    fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_reading_outside_workspace() {
    let root = temp_workspace("escape");
    assert!(read(&root, "../../Cargo.toml", None, None).is_err());
    assert!(read(&root, "missing.txt", None, None).is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn read_supports_line_windowing() {
    let root = temp_workspace("window");
    let body = "l0\nl1\nl2\nl3\n";
    write(&root, "w.txt", body, None).unwrap();
    let paged = read(&root, "w.txt", Some(1), Some(2)).unwrap();
    assert_eq!(paged.content, "l1\nl2");
    assert_eq!(paged.total_lines, 4);
    assert_eq!(paged.offset, 1);
    let tail = read(&root, "w.txt", Some(3), Some(10)).unwrap();
    assert_eq!(tail.content, "l3");
    assert!(read(&root, "w.txt", Some(9), None).is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn read_streams_windows_from_files_larger_than_memory_window_limit() {
    let root = temp_workspace("large-window");
    let line = format!("{}\n", "x".repeat(1023));
    let body = line.repeat(2_100);
    fs::write(root.join("large.txt"), body.as_bytes()).unwrap();
    let outcome = read(&root, "large.txt", Some(2_050), Some(2)).unwrap();
    assert_eq!(outcome.total_lines, 2_100);
    assert_eq!(outcome.content.lines().count(), 2);
    assert!(!outcome.read_complete);
    assert_eq!(outcome.size_bytes, body.len() as u64);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn atomic_write_replaces_and_leaves_no_temporary_file() {
    let root = temp_workspace("atomic");
    let path = root.join("a.txt");
    fs::write(&path, "old").unwrap();
    atomic_write(&path, b"new").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    let names: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("a.txt")]);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn list_paginates_sorted_directory_entries_with_metadata() {
    let root = temp_workspace("pagination");
    write(&root, "z.txt", "z", None).unwrap();
    write(&root, "a.txt", "a", None).unwrap();
    write(&root, "m.txt", "m", None).unwrap();
    let first = list(&root, ".", false, Some(0), Some(2)).unwrap();
    assert_eq!(
        first
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a.txt", "m.txt"]
    );
    assert_eq!(first.returned_count, 2);
    assert!(first.truncated);
    assert_eq!(first.next_offset, Some(2));
    let second = list(&root, ".", false, first.next_offset, Some(2)).unwrap();
    assert_eq!(second.entries[0].path, "z.txt");
    assert_eq!(second.returned_count, 1);
    assert!(!second.truncated);
    assert_eq!(second.next_offset, None);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn recursive_list_walks_nested_dirs() {
    let root = temp_workspace("recursive");
    write(&root, "src/deep/mod.rs", "fn main() {}", None).unwrap();
    write(&root, "README.md", "# hi", None).unwrap();
    let entries = list(&root, ".", true, None, None).unwrap();
    let paths: Vec<&str> = entries.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["README.md", "src/deep/mod.rs"]);
    assert!(!entries.truncated);
    let sub = list(&root, "src", true, None, None).unwrap();
    assert_eq!(sub.returned_count, 1);
    assert_eq!(sub.entries[0].path, "src/deep/mod.rs");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn recursive_list_paginates_in_stable_path_order() {
    let root = temp_workspace("recursive-pagination");
    write(&root, "src/z.rs", "z", None).unwrap();
    write(&root, "README.md", "readme", None).unwrap();
    write(&root, "src/a.rs", "a", None).unwrap();
    let first = list(&root, ".", true, Some(0), Some(2)).unwrap();
    assert_eq!(
        first
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["README.md", "src/a.rs"]
    );
    assert!(first.truncated);
    assert_eq!(first.next_offset, Some(2));
    let second = list(&root, ".", true, first.next_offset, Some(2)).unwrap();
    assert_eq!(second.entries[0].path, "src/z.rs");
    assert_eq!(second.returned_count, 1);
    assert!(!second.truncated);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn list_normalizes_zero_limit_to_at_least_one_entry() {
    let root = temp_workspace("zero-limit");
    write(&root, "b.txt", "b", None).unwrap();
    write(&root, "a.txt", "a", None).unwrap();
    let result = list(&root, ".", false, None, Some(0)).unwrap();
    assert_eq!(result.returned_count, 1);
    assert_eq!(result.entries[0].path, "a.txt");
    assert_eq!(result.next_offset, Some(1));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn list_returns_stable_empty_page_for_offset_beyond_bounds() {
    let root = temp_workspace("offset-beyond");
    write(&root, "a.txt", "a", None).unwrap();
    let result = list(&root, ".", false, Some(1), Some(2)).unwrap();
    assert!(result.entries.is_empty());
    assert_eq!(result.returned_count, 0);
    assert!(!result.truncated);
    assert_eq!(result.next_offset, None);
    let maxed = list(&root, ".", false, Some(usize::MAX), Some(2)).unwrap();
    assert!(maxed.entries.is_empty());
    assert!(!maxed.truncated);
    assert_eq!(maxed.next_offset, None);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn recursive_list_reports_walk_hard_cap_without_fake_continuation() {
    let root = temp_workspace("depth-cap");
    write(&root, "top.txt", "t", None).unwrap();
    let mut deep = root.clone();
    for index in 0..(crate::filesystem::walk::MAX_WALK_DEPTH + 2) {
        deep = deep.join(format!("d{index}"));
        fs::create_dir_all(&deep).unwrap();
    }
    fs::write(deep.join("leaf.txt"), "x").unwrap();
    let result = list(&root, ".", true, None, None).unwrap();
    assert!(result.truncated);
    assert_eq!(result.next_offset, None);
    fs::remove_dir_all(&root).ok();
}
