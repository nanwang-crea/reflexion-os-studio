pub mod policy;
use serde::Serialize;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u64,
    pub origin: String,
    pub filename: String,
    pub path: Option<String>,
    pub status: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub notice: Option<String>,
}
#[tauri::command]
pub async fn browser_downloads(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<Record>, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    super::commands::on_main(app, |_| Ok(super::platform::downloads())).await
}
#[tauri::command]
pub async fn browser_download_action(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: u64,
    kind: String,
) -> Result<Vec<Record>, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    if !super::platform::available() {
        return Err("下载适配不可用".into());
    }
    super::commands::on_main(app, move |_| {
        super::platform::download_action(id, &kind)?;
        Ok(super::platform::downloads())
    })
    .await
}
