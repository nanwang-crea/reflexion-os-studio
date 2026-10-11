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

fn range(start: usize, end: usize, expected: &str, new: &str) -> FileEditOperation {
    FileEditOperation::ReplaceRange {
        start_line: start,
        end_line: end,
        expected_text: expected.into(),
        new_text: new.into(),
    }
}

#[test]
fn numbered_range_handles_absolute_lines_unicode_crlf_and_empty_lines() {
    let (root, revision) = workspace("numbered-range", "\u{feff}head\r\n你好\r\n\r\n末尾\r\n");
    edit(
        &root,
        "a.txt",
        &[range(2, 4, "L2: 你好\r\nL3: \r\nL4: 末尾", "新块\n第二行")],
        Some(revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "\u{feff}head\r\n新块\r\n第二行\r\n"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn numbered_range_rejects_wrong_partial_prefixes_and_preserves_literal_prefixes() {
    let (root, revision) = workspace("literal-prefix", "head\nL2: real\nend");
    for expected in ["L1: L2: real", "L3: L2: real", "L2: real\nL3: end"] {
        assert!(edit(
            &root,
            "a.txt",
            &[range(2, 2, expected, "wrong")],
            Some(revision.clone())
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "head\nL2: real\nend"
        );
    }
    edit(
        &root,
        "a.txt",
        &[range(2, 2, "L2: real", "L99: literal")],
        Some(revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "head\nL99: literal\nend"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn batch_failure_identifies_operation_candidates_and_keeps_original() {
    let (root, revision) = workspace("diagnostic", "head\nx\nx\n");
    let error = edit(
        &root,
        "a.txt",
        &[replace("head", "changed", None), replace("x", "y", None)],
        Some(revision.clone()),
    )
    .err()
    .unwrap();
    let diagnostic = error.diagnostic.unwrap();
    assert_eq!(diagnostic["operationIndex"], 1);
    assert_eq!(diagnostic["actualCount"], 2);
    assert_eq!(diagnostic["candidateLines"], serde_json::json!([2, 3]));
    assert_eq!(diagnostic["noChangesWritten"], true);
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "head\nx\nx\n"
    );
    let error = edit(
        &root,
        "a.txt",
        &[range(2, 3, "wrong", "y")],
        Some(revision.clone()),
    )
    .err()
    .unwrap();
    assert_eq!(error.diagnostic.unwrap()["startLine"], 2);
    let error = edit(
        &root,
        "a.txt",
        &[replace("x", "y", Some(0))],
        Some(revision),
    )
    .err()
    .unwrap();
    assert_eq!(error.diagnostic.unwrap()["reason"], "invalid_count");
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "head\nx\nx\n"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn edits_use_original_snapshot_and_report_overlap_indices() {
    let (root, revision) = workspace("snapshot", "alpha\nbeta");
    let error = edit(
        &root,
        "a.txt",
        &[
            replace("alpha", "new", None),
            replace("new", "chained", None),
        ],
        Some(revision.clone()),
    )
    .err()
    .unwrap();
    assert_eq!(error.diagnostic.unwrap()["operationIndex"], 1);
    let error = edit(
        &root,
        "a.txt",
        &[
            range(1, 2, "alpha\nbeta", "new"),
            replace("beta", "x", None),
        ],
        Some(revision),
    )
    .err()
    .unwrap();
    let diagnostic = error.diagnostic.unwrap();
    assert_eq!(diagnostic["reason"], "overlap");
    assert_eq!(diagnostic["operationIndex"], 1);
    assert_eq!(diagnostic["conflictingOperationIndex"], 0);
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "alpha\nbeta"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn copied_first_line_bom_is_accepted_without_removing_or_duplicating_file_bom() {
    let (root, revision) = workspace("bom-read-range", "\u{feff}head\nbody\n");
    let outcome = edit(
        &root,
        "a.txt",
        &[range(1, 1, "L1: \u{feff}head", "new")],
        Some(revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "\u{feff}new\nbody\n"
    );
    edit(
        &root,
        "a.txt",
        &[replace("L1: \u{feff}new", "next", None)],
        Some(outcome.revision),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "\u{feff}next\nbody\n"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn match_diagnostics_are_bounded_and_range_errors_do_not_write() {
    let original = "same\n".repeat(25);
    let (root, revision) = workspace("bounded-diagnostics", &original);
    let error = edit(
        &root,
        "a.txt",
        &[replace("same", "x", None)],
        Some(revision.clone()),
    )
    .err()
    .unwrap();
    let diagnostic = error.diagnostic.unwrap();
    assert_eq!(diagnostic["actualCount"], 25);
    assert_eq!(diagnostic["candidateLines"].as_array().unwrap().len(), 20);
    for (start, end) in [(0, 1), (3, 2), (1, 100)] {
        let error = edit(
            &root,
            "a.txt",
            &[range(start, end, "same", "x")],
            Some(revision.clone()),
        )
        .err()
        .unwrap();
        assert_eq!(error.diagnostic.unwrap()["reason"], "invalid_range");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), original);
    }
    fs::remove_dir_all(root).ok();
}
