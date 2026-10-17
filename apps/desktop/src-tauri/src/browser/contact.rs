use crate::browser::{preferences::Contact, state};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub(crate) struct PreparedFill {
    pub source: String,
    pub revision: u64,
}

pub(crate) fn script(
    app: &AppHandle,
    id: u32,
    contact: &Contact,
) -> Result<Option<PreparedFill>, String> {
    let snapshot = state::snapshot(app);
    if snapshot.active_tab_id != Some(id)
        || snapshot.status != "ready"
        || !state::preferences(app).contact_autofill
    {
        return Err("请启用联系信息填充，并等待网页加载完成".into());
    }
    let url = snapshot.url.as_ref().ok_or("页面网址不可用")?;
    let source = crate::browser::policy::web_url(url)?;
    if source.scheme() != "https" {
        return Err("联系信息只允许填入 HTTPS 页面".into());
    }
    let origin = source.origin().ascii_serialization();
    if !app
        .dialog()
        .message(format!(
            "将 {} 的联系信息填入 {} 的当前主页面？网站能够读取所填内容；不会自动提交。",
            contact.label, origin
        ))
        .title("填充联系信息")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
    {
        return Ok(None);
    }
    if state::snapshot(app).revision != snapshot.revision
        || !state::preferences(app).contact_autofill
    {
        return Err("页面已切换，请重新确认".into());
    }
    let values = contact.fill_values();
    let url = serde_json::to_string(url).map_err(|_| "页面网址无效")?;
    let origin = serde_json::to_string(&origin).map_err(|_| "页面来源无效")?;
    Ok(Some(PreparedFill {
        source: format!(
            "({})({values}, {url}, {origin})",
            include_str!("contact/fill.js")
        ),
        revision: snapshot.revision,
    }))
}
