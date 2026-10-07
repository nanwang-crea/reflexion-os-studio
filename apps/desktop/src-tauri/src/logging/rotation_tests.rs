use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "reflexion-log-{}-{unique}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rotates_newest_first_and_discards_oldest() {
    let directory = Directory::new();
    let mut log = RotatingLog::new(&directory.0, 8, 3).unwrap();
    for line in ["first", "second", "third", "fourth"] {
        log.write(line).unwrap();
    }
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.log")).unwrap(),
        "fourth\n"
    );
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.1.log")).unwrap(),
        "third\n"
    );
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.2.log")).unwrap(),
        "second\n"
    );
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 3);
}

#[test]
fn restart_appends_then_rotates_existing_file_at_limit() {
    let directory = Directory::new();
    {
        let mut log = RotatingLog::new(&directory.0, 8, 3).unwrap();
        log.write("abc").unwrap();
    }
    let mut log = RotatingLog::new(&directory.0, 8, 3).unwrap();
    log.write("def").unwrap();
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.log")).unwrap(),
        "abc\ndef\n"
    );
    log.write("ghi").unwrap();
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.1.log")).unwrap(),
        "abc\ndef\n"
    );
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.log")).unwrap(),
        "ghi\n"
    );
}

#[test]
fn oversized_unicode_lines_stay_utf8_and_single_file_retention_works() {
    let directory = Directory::new();
    let mut log = RotatingLog::new(&directory.0, 8, 1).unwrap();
    log.write("中文很长的日志").unwrap();
    let text = fs::read_to_string(directory.0.join("studio.log")).unwrap();
    assert_eq!(text, "中文\n");
    log.write("next").unwrap();
    assert_eq!(
        fs::read_to_string(directory.0.join("studio.log")).unwrap(),
        "next\n"
    );
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn concurrent_records_are_complete_and_all_files_are_bounded() {
    let directory = Directory::new();
    let log = std::sync::Arc::new(std::sync::Mutex::new(
        RotatingLog::new(&directory.0, 64, 3).unwrap(),
    ));
    let threads: Vec<_> = (0..4)
        .map(|index| {
            let log = log.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    log.lock()
                        .unwrap()
                        .write(&format!("thread-{index}"))
                        .unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let files: Vec<_> = fs::read_dir(&directory.0).unwrap().collect();
    assert_eq!(files.len(), 3);
    for file in files {
        let file = file.unwrap();
        assert!(file.metadata().unwrap().len() <= 64);
        let text = fs::read_to_string(file.path()).unwrap();
        assert!(text
            .lines()
            .all(|line| ["thread-0", "thread-1", "thread-2", "thread-3"].contains(&line)));
    }
}

#[test]
fn reducing_retention_removes_previous_backups_only() {
    let directory = Directory::new();
    {
        let mut log = RotatingLog::new(&directory.0, 8, 3).unwrap();
        for line in ["first", "second", "third"] {
            log.write(line).unwrap();
        }
    }
    fs::write(directory.0.join("other.log"), "keep").unwrap();
    let _log = RotatingLog::new(&directory.0, 8, 1).unwrap();
    assert!(!directory.0.join("studio.1.log").exists());
    assert!(!directory.0.join("studio.2.log").exists());
    assert_eq!(
        fs::read_to_string(directory.0.join("other.log")).unwrap(),
        "keep"
    );
}
