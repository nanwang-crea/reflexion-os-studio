use super::*;
use std::path::PathBuf;

fn workspace(tag: &str, content: &str) -> (PathBuf, Revision) {
    let root = std::env::temp_dir().join(format!("reflexion-edit-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.txt"), content).unwrap();
    let read = files::read(&root, "a.txt", None, None).unwrap();
    let revision = Revision {
        modified_ms: read.modified_ms,
        size_bytes: read.size_bytes,
        sha256: read.content_sha256,
    };
    (root, revision)
}

fn replace(old_text: &str, new_text: &str, expected_count: Option<usize>) -> FileEditOperation {
    FileEditOperation::Replace {
        old_text: old_text.to_string(),
        new_text: new_text.to_string(),
        expected_count,
    }
}

#[test]
fn exact_replace_checks_count_revision_and_supports_chaining() {
    let (root, revision) = workspace("replace", "fee fee fi");
    let outcome = edit(
        &root,
        "a.txt",
        &[replace("fee", "foo", Some(2))],
        Some(revision.clone()),
    )
    .unwrap();
    assert_eq!(outcome.replaced_count, 2);
    assert_eq!(outcome.changed_files[0].path, "a.txt");
    assert!(edit(&root, "a.txt", &[replace("foo", "x", None)], Some(revision)).is_err());
    edit(
        &root,
        "a.txt",
        &[replace("foo", "fee", Some(2))],
        Some(outcome.revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "fee fee fi"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn edit_requires_revision_and_preserves_crlf_and_bom() {
    let (root, revision) = workspace("crlf", "\u{feff}alpha\r\nbeta\r\n");
    assert!(edit(&root, "a.txt", &[replace("beta", "delta", None)], None).is_err());
    edit(
        &root,
        "a.txt",
        &[replace("beta", "delta", None)],
        Some(revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "\u{feff}alpha\r\ndelta\r\n"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn mixed_batch_returns_patch_and_applies_from_end() {
    let (root, revision) = workspace("batch", "alpha\nbeta\ngamma\n");
    let operations = [
        FileEditOperation::InsertAfter {
            anchor: "alpha".to_string(),
            content: "!".to_string(),
            expected_count: None,
        },
        FileEditOperation::ReplaceRange {
            start_line: 3,
            end_line: 3,
            expected_text: "gamma".to_string(),
            new_text: "GAMMA".to_string(),
        },
    ];
    let outcome = edit(&root, "a.txt", &operations, Some(revision)).unwrap();
    assert_eq!(outcome.structured_patch.len(), 2);
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "alpha!\nbeta\nGAMMA\n"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn overlapping_batch_is_atomic() {
    let (root, revision) = workspace("overlap", "abcdef");
    let result = edit(
        &root,
        "a.txt",
        &[replace("abc", "x", None), replace("bcd", "y", None)],
        Some(revision),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "abcdef");
    fs::remove_dir_all(root).ok();
}

#[test]
fn numbered_read_prefixes_are_stripped_only_as_fallback() {
    let (root, revision) = workspace("prefix", "alpha\nbeta");
    edit(
        &root,
        "a.txt",
        &[replace("L1: alpha\nL2: beta", "done", None)],
        Some(revision),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "done");
    fs::remove_dir_all(root).ok();
}
