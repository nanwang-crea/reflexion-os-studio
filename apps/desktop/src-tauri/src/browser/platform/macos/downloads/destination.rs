use super::*;
use objc2_app_kit::NSSavePanel;

pub(super) fn choose(
    app: &AppHandle,
    response: &NSURLResponse,
    filename: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    let marker = MainThreadMarker::new().ok_or("下载需要主线程")?;
    let url = response
        .URL()
        .and_then(|u| u.absoluteString())
        .ok_or("缺少下载来源")?;
    let origin =
        crate::browser::policy::guest_url(&url.to_string(), crate::browser::policy::dev_url(app))?
            .origin()
            .ascii_serialization();
    let prefs = state::preferences(app);
    let directory = prefs
        .download_directory
        .map(PathBuf::from)
        .or_else(|| app.path().download_dir().ok())
        .ok_or("下载目录不可用")?;
    let directory = policy::directory(&directory.to_string_lossy())?;
    let name = policy::filename(filename);
    let target = if prefs.ask_download_location {
        let panel = NSSavePanel::savePanel(marker);
        panel.setNameFieldStringValue(&NSString::from_str(&name));
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(
            &directory.to_string_lossy(),
        ))));
        if panel.runModal() != 1 {
            return Err("已取消下载".into());
        }
        PathBuf::from(
            panel
                .URL()
                .and_then(|u| u.path())
                .ok_or("下载目标无效")?
                .to_string(),
        )
    } else {
        directory.join(name)
    };
    let parent = policy::directory(&target.parent().ok_or("下载目标无效")?.to_string_lossy())?;
    let target = parent.join(target.file_name().ok_or("文件名无效")?);
    if policy::sensitive(&target) || std::fs::symlink_metadata(&target).is_ok() {
        return Err("目标敏感或已存在，请选择新文件名".into());
    }
    let staging_dir = parent.join(format!(
        ".reflexion-download-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    std::fs::create_dir(&staging_dir).map_err(|_| "无法创建下载暂存目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(&staging_dir, std::fs::Permissions::from_mode(0o700)).is_err() {
            let _ = std::fs::remove_dir(&staging_dir);
            return Err("无法保护暂存目录".into());
        }
    }
    Ok((staging_dir.join("data.part"), target, origin))
}
