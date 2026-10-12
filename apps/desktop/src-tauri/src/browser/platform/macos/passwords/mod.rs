mod auth;
mod editor;
use tauri::AppHandle;
pub async fn manage(
    app: AppHandle,
    kind: String,
    id: Option<usize>,
    origin: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        auth::authenticate()?;
        let entry = if kind == "add" {
            None
        } else {
            let entry = crate::browser::import::vault::get(id.ok_or("缺少密码编号")?)?;
            if Some(&entry.origin) != origin.as_ref() {
                return Err("密码列表已变化，请刷新".into());
            }
            Some(entry)
        };
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(editor::manage(&kind, id, entry));
        })
        .map_err(|_| "密码编辑窗口无法打开")?;
        rx.recv().map_err(|_| "密码管理已取消".to_string())?
    })
    .await
    .map_err(|_| "密码管理未完成".to_string())?
}
