use super::{
    platform,
    state::{self, Action, Snapshot},
    window,
};
use tauri::{AppHandle, Webview};
#[tauri::command]
pub fn browser_capabilities(
    webview: Webview,
    app: AppHandle,
) -> Result<super::capabilities::Capabilities, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    Ok(super::capabilities::report())
}

#[tauri::command]
pub async fn browser_open(
    webview: Webview,
    app: AppHandle,
    url: Option<String>,
) -> Result<Snapshot, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    let url = url
        .map(|raw| {
            super::policy::guest_url(&raw, crate::browser::policy::dev_url(&app))
                .map(|url| url.to_string())
        })
        .transpose()?;
    if !platform::available() && url.is_some() {
        return Ok(state::snapshot(&app));
    }
    on_main(app, move |app| {
        if let Some(url) = url {
            window::control(app, Action::Newtab { url: Some(url) })
        } else {
            Ok(state::snapshot(app))
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_control(
    webview: Webview,
    app: AppHandle,
    action: Action,
) -> Result<Snapshot, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    if !platform::available()
        && !matches!(
            action,
            Action::Attach | Action::Status | Action::Close | Action::Layout { .. }
        )
    {
        return Err("browser Surface unavailable".into());
    }
    if let Action::Layout {
        x,
        y,
        width,
        height,
        visible,
    } = &action
    {
        if [*x, *y, *width, *height]
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0 || *value > 100000.0)
            || (*visible && (*width == 0.0 || *height == 0.0))
        {
            return Err("invalid browser bounds".into());
        }
    }
    if let Action::Navigate { url } | Action::Newtab { url: Some(url) } = &action {
        super::policy::guest_url(url, crate::browser::policy::dev_url(&app))?;
    }
    on_main(app, move |app| {
        if matches!(action, Action::Navigate { .. }) && state::snapshot(app).tabs.is_empty() {
            window::control(app, Action::Attach)?;
        }
        window::control(app, action)
    })
    .await
}

async fn on_main(
    app: AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<Snapshot, String> + Send + 'static,
) -> Result<Snapshot, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(operation(&handle));
    })
    .map_err(|_| "browser dispatch failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "browser dispatch cancelled".to_string())?
    })
    .await
    .map_err(|_| "browser task failed")?
}
