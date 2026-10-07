use super::*;
use crate::filesystem::files::{write, Revision};
use std::path::PathBuf;

fn workspace(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("reflexion-read-{tag}-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn original_read_and_revision_write_preserve_utf8_bytes() {
    let root = workspace("roundtrip");
    for original in [
        "",
        "\n",
        "\r\n",
        "你好\n第二行\n",
        "你好\r\n第二行\r\n",
        "a\r\n\r\n\r\n",
        "a\n\n",
        "no final newline",
        "a\r\nb\n",
        "\u{feff}你好\r\n",
    ] {
        fs::write(root.join("a.txt"), original.as_bytes()).unwrap();
        let result = read_with_line_endings(&root, "a.txt", None, None, true).unwrap();
        assert!(result.read_complete);
        assert_eq!(result.content.as_bytes(), original.as_bytes());
        assert_eq!(
            result.content_sha256,
            crate::filesystem::sha256::hex_digest(original.as_bytes())
        );
        let revision = Revision {
            modified_ms: result.modified_ms,
            size_bytes: result.size_bytes,
            sha256: result.content_sha256,
        };
        write(&root, "a.txt", &result.content, Some(revision)).unwrap();
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), original.as_bytes());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn paged_original_content_retains_line_separators_but_never_grants_overwrite() {
    let root = workspace("pages");
    fs::write(root.join("a.txt"), "a\r\n\r\nb\r\nlast").unwrap();
    let first = read_with_line_endings(&root, "a.txt", None, Some(2), true).unwrap();
    let tail = read_with_line_endings(&root, "a.txt", Some(2), Some(2), true).unwrap();
    assert_eq!(first.content, "a\r\n\r\n");
    assert_eq!(tail.content, "b\r\nlast");
    assert_eq!(
        format!("{}{}", first.content, tail.content),
        "a\r\n\r\nb\r\nlast"
    );
    assert!(!first.read_complete);
    assert!(!tail.read_complete);
    assert_eq!(first.content_sha256, tail.content_sha256);
    assert_eq!(first.total_lines, 4);
    let beyond = read_with_line_endings(&root, "a.txt", Some(4), None, true).unwrap();
    assert_eq!(beyond.content, "");
    assert!(!beyond.read_complete);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn model_read_keeps_existing_numbered_window_input() {
    let root = workspace("model");
    fs::write(root.join("a.txt"), "a\r\nb\r\n").unwrap();
    let result = read(&root, "a.txt", None, None).unwrap();
    assert_eq!(result.content, "a\nb");
    assert!(result.read_complete);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_mode_keeps_workspace_and_selected_byte_limits() {
    let root = workspace("limits");
    assert!(read_with_line_endings(&root, "../outside.txt", None, None, true).is_err());
    fs::write(root.join("a.txt"), vec![b'a'; MAX_READ_BYTES as usize + 1]).unwrap();
    assert!(read_with_line_endings(&root, "a.txt", None, None, true)
        .err()
        .unwrap()
        .contains("exceeds"));
    fs::remove_dir_all(root).unwrap();
}
