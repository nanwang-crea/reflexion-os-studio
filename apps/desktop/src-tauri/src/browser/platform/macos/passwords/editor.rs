use crate::browser::import::vault::{self, Entry};
use objc2_app_kit::{NSAlert, NSSecureTextField, NSTextField, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
use zeroize::Zeroizing;

pub fn manage(kind: &str, id: Option<usize>, original: Option<Entry>) -> Result<bool, String> {
    let marker = MainThreadMarker::new().ok_or("密码窗口需要主线程")?;
    let alert = NSAlert::new(marker);
    alert.setMessageText(&NSString::from_str(match kind {
        "add" => "添加网站密码",
        "edit" => "编辑网站密码",
        "reveal" => "查看网站密码",
        "delete" => "删除网站密码",
        _ => return Err("密码操作无效".into()),
    }));
    alert.setInformativeText(&NSString::from_str(
        "密码仅在此原生窗口中显示，不经过聊天、Runtime 或 Agent。来源必须为精确 HTTPS origin。",
    ));
    alert.addButtonWithTitle(&NSString::from_str(if kind == "reveal" {
        "关闭"
    } else {
        "确认"
    }));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    if kind == "delete" {
        if alert.runModal() != 1000 {
            return Ok(false);
        }
        vault::replace(
            id.ok_or("缺少条目")?,
            original.as_ref().ok_or("条目不存在")?,
            None,
        )?;
        return Ok(true);
    }
    let view = NSView::initWithFrame(
        marker.alloc(),
        NSRect::new(NSPoint::new(0., 0.), NSSize::new(380., 110.)),
    );
    let origin = NSTextField::initWithFrame(
        marker.alloc(),
        NSRect::new(NSPoint::new(0., 75.), NSSize::new(380., 25.)),
    );
    let username = NSTextField::initWithFrame(
        marker.alloc(),
        NSRect::new(NSPoint::new(0., 40.), NSSize::new(380., 25.)),
    );
    let password = NSSecureTextField::initWithFrame(
        marker.alloc(),
        NSRect::new(NSPoint::new(0., 5.), NSSize::new(380., 25.)),
    );
    origin.setPlaceholderString(Some(&NSString::from_str("https://example.com")));
    username.setPlaceholderString(Some(&NSString::from_str("用户名")));
    password.setPlaceholderString(Some(&NSString::from_str("密码")));
    if let Some(entry) = original.as_ref() {
        origin.setStringValue(&NSString::from_str(&entry.origin));
        username.setStringValue(&NSString::from_str(&entry.username));
        password.setStringValue(&NSString::from_str(&entry.password));
    }
    origin.setEditable(kind == "add");
    username.setEditable(kind != "reveal");
    password.setEditable(kind != "reveal");
    view.addSubview(&origin);
    view.addSubview(&username);
    let revealed = if kind == "reveal" {
        let field = NSTextField::initWithFrame(
            marker.alloc(),
            NSRect::new(NSPoint::new(0., 5.), NSSize::new(380., 25.)),
        );
        field.setEditable(false);
        field.setStringValue(&NSString::from_str(
            &original.as_ref().ok_or("条目不存在")?.password,
        ));
        view.addSubview(&field);
        Some(field)
    } else {
        view.addSubview(&password);
        None
    };
    alert.setAccessoryView(Some(&view));
    let accepted = alert.runModal() == 1000;
    let raw_password = Zeroizing::new(password.stringValue().to_string());
    let new_entry = Entry {
        origin: origin.stringValue().to_string(),
        username: username.stringValue().to_string(),
        password: raw_password.to_string(),
    };
    password.setStringValue(&NSString::new());
    username.setStringValue(&NSString::new());
    if let Some(field) = revealed {
        field.setStringValue(&NSString::new());
    }
    if !accepted || kind == "reveal" {
        return Ok(accepted);
    }
    let url = crate::browser::policy::web_url(&new_entry.origin)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != new_entry.origin
        || new_entry.username.len() > 1000
        || new_entry.password.is_empty()
        || new_entry.password.len() > 10000
    {
        return Err("密码来源、用户名或密码无效".into());
    }
    if kind == "add" {
        vault::merge(vec![new_entry])?;
    } else {
        vault::replace(
            id.ok_or("缺少条目")?,
            original.as_ref().ok_or("条目不存在")?,
            Some(new_entry),
        )?;
    }
    Ok(true)
}
