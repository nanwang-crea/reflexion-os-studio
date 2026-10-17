//! Await user confirmation off-thread; CEF and its registry stay on the UI thread.
use crate::browser::{commands::on_main, preferences::Contact, state};
use cef::*;

pub async fn fill(app: tauri::AppHandle, contact: Contact) -> Result<state::Snapshot, String> {
    let id = on_main(app.clone(), |app| {
        super::registry::active_user(app)?;
        state::snapshot(app)
            .active_tab_id
            .ok_or("没有活动网页".into())
    })
    .await?;
    let handle = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        crate::browser::contact::script(&handle, id, &contact)
    })
    .await
    .map_err(|_| "联系信息确认失败")??;
    on_main(app, move |app| {
        if let Some(prepared) = prepared {
            if state::snapshot(app).revision != prepared.revision {
                return Err("页面已切换，请重新确认".into());
            }
            super::registry::active_user(app)?
                .main_frame()
                .ok_or("page closed")?
                .execute_java_script(Some(&CefString::from(prepared.source.as_str())), None, 0);
            state::update_tab(app, id, |tab| {
                tab.notice = Some("已请求填充联系信息，请检查页面后自行提交".into());
            });
        }
        Ok(state::snapshot(app))
    })
    .await
}
