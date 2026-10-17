use std::{
    path::Path,
    process::{Command, Stdio},
};

pub(super) fn file(path: &str) -> Result<(), String> {
    let path = Path::new(path)
        .canonicalize()
        .map_err(|_| "下载文件已不存在")?;
    if !path.is_file() || crate::browser::downloads::policy::sensitive(&path) {
        return Err("禁止显示此下载路径".into());
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        // One argument; never interpreted by a shell or executed as a downloaded file.
        let mut selection = std::ffi::OsString::from("/select,");
        selection.push(&path);
        command.arg(selection);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path.parent().ok_or("下载目录不可用")?);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法打开系统文件管理器")?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
