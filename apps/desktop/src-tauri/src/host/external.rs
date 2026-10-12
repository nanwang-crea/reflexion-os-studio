use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn open_external(webview: Webview, app: AppHandle, url: String) -> Result<(), String> {
    super::caller::trusted(&webview, &app, &["main", "browser-toolbar"])?;
    let parsed = crate::browser::policy::web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let status = open_with_system_browser(parsed.as_str())
            .map_err(|_| "failed to open system browser")?;
        if status.success() {
            Ok(())
        } else {
            Err("system browser failed".into())
        }
    })
    .await
    .map_err(|_| "system browser task failed")?
}

#[cfg(target_os = "macos")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
}
#[cfg(target_os = "windows")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .status()
}
#[cfg(target_os = "linux")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("xdg-open").arg(url).status()
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn open_with_system_browser(_url: &str) -> std::io::Result<std::process::ExitStatus> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ))
}
