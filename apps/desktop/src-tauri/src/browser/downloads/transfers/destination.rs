use crate::browser::{downloads::policy, state};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub(super) fn prepare(
    app: &AppHandle,
    source: &str,
    name: &str,
) -> Result<(String, PathBuf, PathBuf), String> {
    let url = crate::browser::policy::guest_url(source, crate::browser::policy::dev_url(app))?;
    let snapshot = state::snapshot(app);
    let page = snapshot
        .url
        .as_ref()
        .and_then(|url| crate::browser::policy::web_url(url).ok())
        .ok_or("下载页面不可用")?;
    if page.origin() != url.origin() {
        return Err("跨来源下载重定向已拒绝".into());
    }
    let preferences = state::preferences(app);
    let directory = if let Some(path) = preferences.download_directory {
        policy::directory(&path)?
    } else {
        app.path()
            .download_dir()
            .map_err(|_| "下载目录不可用")?
            .canonicalize()
            .map_err(|_| "下载目录不可用")?
    };
    let name = policy::filename(name);
    let target = if preferences.ask_download_location {
        app.dialog()
            .file()
            .set_directory(&directory)
            .set_file_name(&name)
            .blocking_save_file()
            .ok_or("已取消选择下载位置")?
            .into_path()
            .map_err(|_| "下载目标必须为本地文件")?
    } else {
        directory.join(name)
    };
    if state::snapshot(app).revision != snapshot.revision {
        return Err("下载页面已切换，请重试".into());
    }
    let parent = target.parent().ok_or("下载目标无效")?;
    let parent = policy::directory(&parent.to_string_lossy())?;
    let target = parent.join(target.file_name().ok_or("下载文件名无效")?);
    if policy::sensitive(&target) || target.symlink_metadata().is_ok() {
        return Err("目标敏感或已存在，请选择新文件名".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "时钟不可用")?
        .as_nanos();
    let stage_directory = parent.join(format!(
        ".reflexion-download-{}-{nonce}",
        std::process::id()
    ));
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };

    builder
        .create(&stage_directory)
        .map_err(|_| "无法创建下载暂存目录")?;
    Ok((
        url.origin().ascii_serialization(),
        stage_directory.join("payload"),
        target,
    ))
}
pub(super) fn cleanup(stage: &std::path::Path) {
    let _ = std::fs::remove_file(stage);
    if let Some(directory) = stage.parent() {
        let _ = std::fs::remove_dir(directory);
    }
}
