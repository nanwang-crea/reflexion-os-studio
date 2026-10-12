use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[cfg(all(feature = "browser-spike", target_os = "macos"))]
pub(crate) mod chromium;
#[cfg(all(feature = "browser-spike", target_os = "macos"))]
mod crypto;
#[cfg(all(feature = "browser-spike", target_os = "macos"))]
pub(crate) mod vault;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    source: String,
    profile: String,
    cookies: bool,
    passwords: bool,
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        let valid_profile = self.profile == "Default"
            || self.profile.strip_prefix("Profile ").is_some_and(|value| {
                value.len() <= 4
                    && !value.starts_with('0')
                    && value.parse::<u32>().is_ok_and(|id| id > 0)
            });
        if !matches!(self.source.as_str(), "chrome" | "edge")
            || !valid_profile
            || !(self.cookies || self.passwords)
        {
            return Err("请选择 Chrome / Edge、有效配置和导入内容".into());
        }
        Ok(())
    }
}
#[derive(Default, Serialize)]
pub struct Report {
    pub cookies: usize,
    pub passwords: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub notice: String,
}
#[derive(Serialize)]
pub struct Credential {
    pub id: usize,
    pub origin: String,
    pub label: String,
}
fn supported() -> Result<(), String> {
    if super::platform::available() {
        Ok(())
    } else {
        Err("当前构建不支持直接迁移；需要已验证的原生浏览器和系统凭据适配".into())
    }
}
#[tauri::command]
pub async fn browser_import(
    webview: Webview,
    app: AppHandle,
    request: Request,
) -> Result<Report, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    supported()?;
    request.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let contents = match (request.cookies, request.passwords) {
            (true, true) => "Cookie 和密码", (true, false) => "Cookie", _ => "密码",
        };
        let expected_tab = crate::browser::state::snapshot(&app).active_tab_id;
        let expected_storage = crate::browser::state::preferences(&app).storage_mode;
        let parent = app.get_webview_window("main").ok_or("主窗口已关闭")?;
        if !app.dialog().message(format!("从 {} 的 {} 配置迁移{}？\n请先关闭来源浏览器。Cookie 进入本应用当前独立浏览会话（保存方式跟随临时/持久设置），密码保存在本应用的系统钥匙串条目。Agent 不可访问这些数据。", request.source, request.profile, contents))
            .parent(&parent).title("确认浏览器迁移").buttons(MessageDialogButtons::OkCancel).blocking_show() {
            return Ok(Report { cancelled: true, notice: "已取消，未读取浏览器数据".into(), ..Report::default() });
        }
        if expected_tab != crate::browser::state::snapshot(&app).active_tab_id || expected_storage != crate::browser::state::preferences(&app).storage_mode { return Err("导入目标会话已变化，请重新确认".into()); }
        #[cfg(all(feature = "browser-spike", target_os = "macos"))]
        { chromium::import(&app, request) }
        #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
        { Err("本平台尚无直接迁移适配".into()) }
    }).await.map_err(|_| "迁移任务未完成".to_string())?
}
#[tauri::command]
pub async fn browser_credentials(
    webview: Webview,
    app: AppHandle,
) -> Result<Vec<Credential>, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    supported()?;
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(vault::list)
            .await
            .map_err(|_| "密码列表不可用".to_string())?
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        Err("本平台尚无密码存储适配".into())
    }
}
#[tauri::command]
pub async fn browser_clear_credentials(webview: Webview, app: AppHandle) -> Result<bool, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    supported()?;
    tauri::async_runtime::spawn_blocking(move || {
        let parent = app.get_webview_window("main").ok_or("主窗口已关闭")?;
        if !app
            .dialog()
            .message("删除本应用全部导入的密码？来源浏览器不受影响。")
            .parent(&parent)
            .title("删除导入密码")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
        {
            return Ok(false);
        }
        #[cfg(all(feature = "browser-spike", target_os = "macos"))]
        {
            vault::clear().map(|()| true)
        }
        #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
        {
            Err("本平台尚无密码存储适配".into())
        }
    })
    .await
    .map_err(|_| "删除密码未完成".to_string())?
}
#[tauri::command]
pub async fn browser_fill(webview: Webview, app: AppHandle, id: usize) -> Result<(), String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    supported()?;
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        let entry = tauri::async_runtime::spawn_blocking(move || vault::get(id))
            .await
            .map_err(|_| "密码不可用".to_string())??;
        super::platform::fill(&app, entry).await
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        let _ = id;
        Err("本平台尚无密码填充适配".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_request_cannot_select_arbitrary_files() {
        for profile in [
            "../Default",
            "/tmp/profile",
            "Profile 0",
            "Profile -1",
            "Profile 99999",
        ] {
            assert!(Request {
                source: "chrome".into(),
                profile: profile.into(),
                cookies: true,
                passwords: false
            }
            .validate()
            .is_err());
        }
        assert!(Request {
            source: "chrome".into(),
            profile: "Default".into(),
            cookies: true,
            passwords: true
        }
        .validate()
        .is_ok());
    }
}

#[tauri::command]
pub async fn browser_password_manage(
    webview: Webview,
    app: AppHandle,
    kind: String,
    id: Option<usize>,
    origin: Option<String>,
) -> Result<bool, String> {
    crate::host::caller::trusted(&webview, &app, &["main"])?;
    supported()?;
    if !matches!(kind.as_str(), "add" | "edit" | "reveal" | "delete")
        || origin.as_ref().is_some_and(|s| s.len() > 8192)
    {
        return Err("密码管理请求无效".into());
    }
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        super::platform::manage_password(app, kind, id, origin).await
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        let _ = (app, kind, id, origin);
        Err("本平台尚无密码管理适配".into())
    }
}
