use super::*;
use crate::git::testutil::temp_workspace;

#[test]
fn baseline_objects_and_branches_work_without_spawning_git() {
    let root = temp_workspace("native-baseline");
    let repo = gix::init(&root).unwrap();
    let blob_id = repo.write_blob(b"baseline\n").unwrap().detach();
    let tree = gix::objs::Tree {
        entries: vec![gix::objs::tree::Entry {
            mode: gix::objs::tree::EntryKind::Blob.into(),
            filename: "file.txt".into(),
            oid: blob_id,
        }],
    };
    let tree_id = repo.write_object(&tree).unwrap().detach();
    let signature = gix::actor::Signature {
        name: "test".into(),
        email: "test@example.com".into(),
        time: gix::date::Time::new(0, 0),
    };
    let mut buffer = gix::date::parse::TimeBuf::default();
    let signature = signature.to_ref(&mut buffer);
    repo.commit_as(
        signature,
        signature,
        "HEAD",
        "baseline",
        tree_id,
        Vec::<gix::ObjectId>::new(),
    )
    .unwrap();
    assert_eq!(
        blob(&root, "HEAD:./file.txt").unwrap(),
        Some(Some(b"baseline\n".to_vec()))
    );
    assert_eq!(blob(&root, "HEAD:./missing.txt").unwrap(), Some(None));
    assert_eq!(blob(&root, "HEAD^:./file.txt").unwrap(), Some(None));
    let result = branches(&root).unwrap();
    assert!(result.repo);
    assert!(result.current.is_some());
}

#[test]
fn nested_workspace_reads_correct_tree_path() {
    let Some(root) = crate::git::testutil::temp_repo("native-nested") else {
        return;
    };
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(root.join("nested").join("file.txt"), "nested\n").unwrap();
    crate::git::testutil::git_cli(&root, &["add", "."]);
    crate::git::testutil::git_cli(&root, &["commit", "-qm", "nested"]);
    assert_eq!(
        blob(&root.join("nested"), "HEAD:./file.txt").unwrap(),
        Some(Some(b"nested\n".to_vec()))
    );
    assert_eq!(
        blob(&root.join("nested"), ":./file.txt").unwrap(),
        Some(Some(b"nested\n".to_vec()))
    );
}
