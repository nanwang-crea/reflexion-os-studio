//! 可恢复的大文件写入：分块只写同目录 staging 文件，commit 时才原子替换目标。
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::files::{self, Revision, WriteOutcome};
use super::paths::resolve_in_workspace;

pub const MAX_CHUNK_BYTES: usize = 512 * 1024;
pub const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const UPLOAD_VERSION: u8 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOutcome {
    pub upload_id: String,
    pub next_offset: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendOutcome {
    pub accepted_bytes: u64,
    pub chunk_sha256: String,
    pub next_offset: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadMetadata {
    version: u8,
    upload_id: String,
    relative_path: String,
    next_offset: u64,
    target_existed: bool,
    revision: Option<Revision>,
}

pub fn begin(
    workspace_root: &Path,
    relative: &str,
    revision: Option<Revision>,
) -> Result<BeginOutcome, String> {
    let target = resolve_in_workspace(workspace_root, relative)?;
    let existed = files::validate_write_target(&target, relative, revision.as_ref())?;
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let upload_id = new_upload_id(relative);
    let (part, metadata_path) = upload_paths(&target, &upload_id)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|error| error.to_string())?
        .sync_all()
        .map_err(|error| error.to_string())?;
    let metadata = UploadMetadata {
        version: UPLOAD_VERSION,
        upload_id: upload_id.clone(),
        relative_path: relative.to_string(),
        next_offset: 0,
        target_existed: existed,
        revision,
    };
    if let Err(error) = persist_metadata(&metadata_path, &metadata) {
        let _ = fs::remove_file(&part);
        return Err(error);
    }
    Ok(BeginOutcome {
        upload_id,
        next_offset: 0,
    })
}

pub fn append(
    workspace_root: &Path,
    relative: &str,
    upload_id: &str,
    offset: u64,
    content: &[u8],
    expected_sha256: &str,
) -> Result<AppendOutcome, String> {
    if content.len() > MAX_CHUNK_BYTES {
        return Err(format!(
            "upload chunk too large: {} bytes (limit {MAX_CHUNK_BYTES})",
            content.len()
        ));
    }
    let target = resolve_in_workspace(workspace_root, relative)?;
    let (part, metadata_path) = upload_paths(&target, upload_id)?;
    let mut metadata = load_metadata(&metadata_path, relative, upload_id)?;
    let actual_sha256 = format!("{:x}", Sha256::digest(content));
    if actual_sha256 != expected_sha256.to_ascii_lowercase() {
        return Err("upload chunk sha256 mismatch".to_string());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&part)
        .map_err(|_| "upload staging file not found".to_string())?;
    let actual_length = file.metadata().map_err(|error| error.to_string())?.len();
    let chunk_end = offset
        .checked_add(content.len() as u64)
        .ok_or_else(|| "upload size overflow".to_string())?;
    if chunk_end > MAX_UPLOAD_BYTES {
        return Err(format!(
            "upload exceeds maximum size of {MAX_UPLOAD_BYTES} bytes"
        ));
    }
    if offset < metadata.next_offset && chunk_end == metadata.next_offset {
        verify_staged_chunk(&mut file, offset, content)?;
        return Ok(AppendOutcome {
            accepted_bytes: content.len() as u64,
            chunk_sha256: actual_sha256,
            next_offset: metadata.next_offset,
        });
    }
    if offset != metadata.next_offset {
        return Err(format!(
            "upload offset mismatch: expected {}, received {offset}",
            metadata.next_offset
        ));
    }
    if actual_length == chunk_end {
        verify_staged_chunk(&mut file, offset, content)?;
        metadata.next_offset = chunk_end;
        persist_metadata(&metadata_path, &metadata)?;
        return Ok(AppendOutcome {
            accepted_bytes: content.len() as u64,
            chunk_sha256: actual_sha256,
            next_offset: chunk_end,
        });
    }
    if actual_length != offset {
        return Err("upload staging length does not match checkpoint".to_string());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    file.write_all(content).map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())?;
    metadata.next_offset = chunk_end;
    persist_metadata(&metadata_path, &metadata)?;
    Ok(AppendOutcome {
        accepted_bytes: content.len() as u64,
        chunk_sha256: actual_sha256,
        next_offset: metadata.next_offset,
    })
}

fn verify_staged_chunk(file: &mut fs::File, offset: u64, expected: &[u8]) -> Result<(), String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut actual = vec![0u8; expected.len()];
    file.read_exact(&mut actual)
        .map_err(|error| error.to_string())?;
    if actual != expected {
        return Err("upload retry content does not match staged bytes".to_string());
    }
    Ok(())
}

pub fn commit(
    workspace_root: &Path,
    relative: &str,
    upload_id: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<WriteOutcome, String> {
    let target = resolve_in_workspace(workspace_root, relative)?;
    let (part, metadata_path) = upload_paths(&target, upload_id)?;
    let metadata = load_metadata(&metadata_path, relative, upload_id)?;
    let size = fs::metadata(&part)
        .map_err(|_| "upload staging file not found".to_string())?
        .len();
    if size != metadata.next_offset || expected_size.is_some_and(|value| value != size) {
        return Err(format!(
            "upload size mismatch: staged {size}, checkpoint {}",
            metadata.next_offset
        ));
    }
    let sha256 = hash_file(&part)?;
    if expected_sha256.is_some_and(|value| value.to_ascii_lowercase() != sha256) {
        return Err("upload final sha256 mismatch".to_string());
    }
    let exists_now = files::validate_write_target(&target, relative, metadata.revision.as_ref())?;
    if exists_now != metadata.target_existed {
        return Err("file changed since upload began; restart the upload".to_string());
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&part)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    #[cfg(unix)]
    if let Ok(target_metadata) = fs::metadata(&target) {
        let _ = fs::set_permissions(&part, target_metadata.permissions());
    }
    files::replace_file(&part, &target)?;
    let _ = fs::remove_file(&metadata_path);
    #[cfg(unix)]
    fs::File::open(target.parent().unwrap())
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    let modified_ms = files::mtime_ms(&target)?;
    Ok(WriteOutcome {
        written_bytes: size,
        created: !metadata.target_existed,
        modified_ms,
        revision: Revision {
            modified_ms,
            size_bytes: size,
            sha256,
        },
    })
}

pub fn abort(workspace_root: &Path, relative: &str, upload_id: &str) -> Result<(), String> {
    let target = resolve_in_workspace(workspace_root, relative)?;
    let (part, metadata_path) = upload_paths(&target, upload_id)?;
    let _ = load_metadata(&metadata_path, relative, upload_id)?;
    remove_if_exists(&part)?;
    remove_if_exists(&metadata_path)
}

fn upload_paths(target: &Path, upload_id: &str) -> Result<(PathBuf, PathBuf), String> {
    if upload_id.len() != 64 || !upload_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid upload id".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let name = target
        .file_name()
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string_lossy();
    Ok((
        parent.join(format!(".{name}.upload-{upload_id}.part")),
        parent.join(format!(".{name}.upload-{upload_id}.json")),
    ))
}

fn persist_metadata(path: &Path, metadata: &UploadMetadata) -> Result<(), String> {
    let bytes = serde_json::to_vec(metadata).map_err(|error| error.to_string())?;
    files::atomic_write(path, &bytes)
}

fn load_metadata(path: &Path, relative: &str, upload_id: &str) -> Result<UploadMetadata, String> {
    let bytes = fs::read(path).map_err(|_| "upload not found or expired".to_string())?;
    let metadata: UploadMetadata =
        serde_json::from_slice(&bytes).map_err(|_| "invalid upload checkpoint".to_string())?;
    if metadata.version != UPLOAD_VERSION
        || metadata.upload_id != upload_id
        || metadata.relative_path != relative
    {
        return Err("upload checkpoint does not match target".to_string());
    }
    Ok(metadata)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn new_upload_id(relative: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{}:{now}:{sequence}:{relative}", std::process::id());
    format!("{:x}", Sha256::digest(seed.as_bytes()))
}

pub(crate) fn is_upload_artifact_name(name: &str) -> bool {
    name.starts_with('.')
        && name.contains(".upload-")
        && (name.ends_with(".part") || name.ends_with(".json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("reflexion-upload-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn uploads_large_file_in_verified_chunks_and_commits_atomically() {
        let root = temp_workspace("large");
        let begin = begin(&root, "large.txt", None).unwrap();
        let chunk = "大文件内容\n".repeat(20_000);
        let bytes = chunk.as_bytes();
        let digest = format!("{:x}", Sha256::digest(bytes));
        let mut next_offset = 0;
        for _ in 0..8 {
            next_offset = append(
                &root,
                "large.txt",
                &begin.upload_id,
                next_offset,
                bytes,
                &digest,
            )
            .unwrap()
            .next_offset;
        }
        assert!(!root.join("large.txt").exists());
        assert!(files::list(&root, ".", false, None, None)
            .unwrap()
            .entries
            .is_empty());
        let expected = bytes.repeat(8);
        assert!(expected.len() > 2 * 1024 * 1024);
        let expected_sha = format!("{:x}", Sha256::digest(&expected));
        let outcome = commit(
            &root,
            "large.txt",
            &begin.upload_id,
            Some(next_offset),
            Some(&expected_sha),
        )
        .unwrap();
        assert!(outcome.created);
        assert_eq!(fs::read(root.join("large.txt")).unwrap(), expected);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn append_retry_is_idempotent_and_wrong_offset_is_rejected() {
        let root = temp_workspace("retry");
        let begin = begin(&root, "retry.txt", None).unwrap();
        let content = b"same chunk";
        let digest = format!("{:x}", Sha256::digest(content));
        let first = append(&root, "retry.txt", &begin.upload_id, 0, content, &digest).unwrap();
        let retried = append(&root, "retry.txt", &begin.upload_id, 0, content, &digest).unwrap();
        assert_eq!(retried.next_offset, first.next_offset);
        assert!(append(
            &root,
            "retry.txt",
            &begin.upload_id,
            1,
            b"different",
            &format!("{:x}", Sha256::digest(b"different")),
        )
        .is_err());
        abort(&root, "retry.txt", &begin.upload_id).unwrap();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_rejects_target_changed_after_begin() {
        let root = temp_workspace("stale");
        fs::write(root.join("a.txt"), "old").unwrap();
        let current = files::read(&root, "a.txt", None, None).unwrap();
        let revision = Revision {
            modified_ms: current.modified_ms,
            size_bytes: current.size_bytes,
            sha256: current.content_sha256,
        };
        let begin = begin(&root, "a.txt", Some(revision)).unwrap();
        fs::write(root.join("a.txt"), "external change").unwrap();
        assert!(commit(&root, "a.txt", &begin.upload_id, Some(0), None).is_err());
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "external change"
        );
        abort(&root, "a.txt", &begin.upload_id).unwrap();
        fs::remove_dir_all(&root).ok();
    }
}
