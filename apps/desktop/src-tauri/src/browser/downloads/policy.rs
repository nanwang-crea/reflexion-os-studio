use std::path::{Component, Path, PathBuf};

pub fn directory(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("下载目录必须为有效的绝对路径".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "下载目录不存在或无法访问")?;
    if !canonical.is_dir() || sensitive(&canonical) {
        return Err("禁止使用此下载目录".into());
    }
    Ok(canonical)
}
pub fn sensitive(path: &Path) -> bool {
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".ssh"
                | ".gnupg"
                | ".aws"
                | ".config"
                | ".docker"
                | "keychains"
                | "credentials.json"
                | "secrets.json"
                | ".npmrc"
                | ".netrc"
                | "passwd"
                | "shadow"
                | "sudoers"
                | "login data"
                | "cookies"
                | "local state"
                | "chrome"
                | "chromium"
                | "edge"
                | "firefox"
                | "safari"
                | "com.apple.safari"
                | "mail"
                | "messages"
        ) || name == ".env"
            || name.starts_with(".env.")
            || name.ends_with(".key")
            || name.ends_with(".pem")
            || name.ends_with(".token")
    })
}
#[cfg(any(
    test,
    all(feature = "browser-spike", target_os = "macos"),
    target_os = "windows",
    target_os = "linux"
))]
pub fn filename(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\0'
                )
        })
        .scan(0usize, |length, c| {
            *length += c.len_utf8();
            Some((*length, c))
        })
        .take_while(|(length, _)| *length <= 200)
        .map(|(_, c)| c)
        .collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() {
        return "download".into();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if reserved {
        format!("_{name}")
    } else {
        name.into()
    }
}
#[cfg(any(
    test,
    all(feature = "browser-spike", target_os = "macos"),
    target_os = "windows",
    target_os = "linux"
))]
pub fn publish(stage: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("下载目标无效")?;
    if directory(&parent.to_string_lossy())? != parent || sensitive(target) {
        return Err("下载目录已变化或目标敏感".into());
    }
    let file_type = stage
        .symlink_metadata()
        .map_err(|_| "暂存文件已不存在")?
        .file_type();
    if !file_type.is_file() {
        return Err("只允许发布普通下载文件".into());
    }
    // Atomic refusal to replace an existing file or symbolic link.
    std::fs::hard_link(stage, target).map_err(|_| "无法安全保存下载文件；目标可能已存在".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suggested_names_are_portable_and_never_windows_devices() {
        for name in ["CON", "nul.txt", "CoM1.zip", "LPT9", "COM¹.txt", "CONOUT$"] {
            assert!(filename(name).starts_with('_'), "{name}");
        }
        assert_eq!(filename("report<>:\"|?*.pdf"), "report.pdf");
        assert_eq!(filename("LPT10.txt"), "LPT10.txt");
        assert_eq!(filename("中文报告.pdf"), "中文报告.pdf");
    }
    #[test]
    fn untrusted_names_cannot_choose_a_directory_or_sensitive_target() {
        assert_eq!(filename("../../one\\two\n"), "onetwo");
        assert!(sensitive(Path::new("/tmp/.ssh/key")));
        assert!(sensitive(Path::new("/tmp/.env.local")));
        assert!(directory("../downloads").is_err());
        assert!(!sensitive(Path::new("/tmp/report.pdf")));
        assert!(sensitive(Path::new("/tmp/Chrome/Default/file")));
        assert!(filename(&"𠮷".repeat(200)).len() <= 200);
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn special_files_cannot_be_published_as_downloads() {
        use std::os::unix::ffi::OsStrExt;
        let root = std::env::temp_dir().join(format!(
            "reflexion-publish-special-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let stage = root.join("stage-pipe");
        let native = std::ffi::CString::new(stage.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
        let target = root.join("download.txt");
        assert!(publish(&stage, &target).is_err());
        assert!(!target.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publishes_without_overwriting_and_rejects_sensitive_targets() {
        let root = std::env::temp_dir().join(format!(
            "reflexion-publish-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let stage = root.join("stage");
        let target = root.join("report.txt");
        std::fs::write(&stage, b"new synthetic content").unwrap();
        std::fs::write(&target, b"existing synthetic content").unwrap();
        assert!(publish(&stage, &target).is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"existing synthetic content"
        );
        assert!(publish(&stage, &root.join(".env.fixture")).is_err());
        std::fs::remove_file(&target).unwrap();
        publish(&stage, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new synthetic content");
        std::fs::remove_dir_all(root).unwrap();
    }
}
