use crate::browser::{preferences::Contact, state};
use block2::RcBlock;
use objc2_app_kit::NSAlert;
use objc2_foundation::{MainThreadMarker, NSString};
use objc2_web_kit::WKWebView;
use tauri::AppHandle;

pub(super) fn confirm(title: &str, message: &str) -> bool {
    let Some(marker) = MainThreadMarker::new() else {
        return false;
    };
    let alert = NSAlert::new(marker);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str("仅此次允许"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    alert.runModal() == 1000
}
fn origin(view: &WKWebView) -> Option<String> {
    unsafe { view.URL().and_then(|u| u.absoluteString()) }
        .and_then(|raw| url::Url::parse(&raw.to_string()).ok())
        .filter(|url| url.scheme() == "https")
        .map(|url| url.origin().ascii_serialization())
}
pub fn fill(app: &AppHandle, view: &WKWebView, contact: &Contact) -> Result<(), String> {
    if !state::preferences(app).contact_autofill || state::snapshot(app).status != "ready" {
        return Err("请启用手动联系信息填充，并等待网页加载完成".into());
    }
    let snapshot = state::snapshot(app);
    let expected = origin(view).ok_or("联系信息只允许填入 HTTPS 页面")?;
    if !confirm(
        "填充联系信息",
        &format!(
            "将 {} 的联系信息填入 {} 的当前主页面？网站能够读取所填内容；不会自动提交。",
            contact.label, expected
        ),
    ) {
        return Ok(());
    }
    if origin(view).as_ref() != Some(&expected)
        || state::snapshot(app).revision != snapshot.revision
        || !state::preferences(app).contact_autofill
    {
        return Err("页面已切换，请重新确认".into());
    }
    let values = serde_json::to_string(contact).map_err(|_| "联系信息无效")?;
    let expected_url = serde_json::to_string(&snapshot.url).map_err(|_| "页面无效")?;
    let expected = serde_json::to_string(&expected).map_err(|_| "来源无效")?;
    let script = format!(
        r#"(() => {{
      if (location.protocol !== 'https:' || location.origin !== {expected} || location.href !== {expected_url}) return false;
      const c = {values}; const fields = {{name:c.name,email:c.email,tel:c.phone,'street-address':c.address}};
      let count = 0;
      for (const input of document.querySelectorAll('input[autocomplete],textarea[autocomplete]')) {{
        const key = input.autocomplete.trim().split(/\s+/).at(-1);
        if (!(key in fields) || !fields[key] || input.type === 'password' || input.type === 'hidden' || input.disabled || input.readOnly || !input.getClientRects().length) continue;
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,fields[key]);
        count++; input.dispatchEvent(new Event('input',{{bubbles:true}})); input.dispatchEvent(new Event('change',{{bubbles:true}}));
      }} return count > 0;
    }})()"#
    );
    unsafe {
        view.evaluateJavaScript_completionHandler(
            &NSString::from_str(&script),
            Some(&RcBlock::new({
                let app = app.clone();
                move |value: *mut objc2::runtime::AnyObject,
                      error: *mut objc2_foundation::NSError| {
                    let success = error.is_null()
                        && value
                            .as_ref()
                            .and_then(|v| v.downcast_ref::<objc2_foundation::NSNumber>())
                            .is_some_and(|v| v.boolValue());
                    if let Some(id) = snapshot.active_tab_id {
                        state::update_tab(&app, id, |s| {
                            s.notice = Some(
                                if success {
                                    "联系信息已填入，请检查后自行提交"
                                } else {
                                    "未找到可填充字段，或页面已切换"
                                }
                                .into(),
                            )
                        });
                    }
                }
            })),
        );
    }
    Ok(())
}
