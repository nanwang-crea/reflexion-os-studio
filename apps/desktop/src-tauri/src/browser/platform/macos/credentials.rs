use super::registry::REGISTRY;
use crate::browser::{
    import::{chromium::Cookie, vault::Entry},
    state,
};
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSHTTPCookie, NSNumber, NSString};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::AppHandle;
use zeroize::Zeroizing;

fn native_cookie(cookie: &Cookie) -> Result<objc2::rc::Retained<NSHTTPCookie>, String> {
    use objc2_foundation::*;
    let name = NSString::from_str(&cookie.name);
    let value = NSString::from_str(&cookie.value);
    let domain = NSString::from_str(&cookie.host);
    let path = NSString::from_str(&cookie.path);
    let yes = NSString::from_str("TRUE");
    let http_only = NSString::from_str("HttpOnly");
    let same_site = NSString::from_str(&cookie.same_site);
    let expiry = cookie.expires.map(NSDate::dateWithTimeIntervalSince1970);
    unsafe {
        let mut keys = vec![
            NSHTTPCookieName,
            NSHTTPCookieValue,
            NSHTTPCookieDomain,
            NSHTTPCookiePath,
        ];
        let mut values: Vec<&AnyObject> = vec![&name, &value, &domain, &path];
        if cookie.secure {
            keys.push(NSHTTPCookieSecure);
            values.push(&yes);
        }
        if cookie.http_only {
            keys.push(&http_only);
            values.push(&yes);
        }
        if !cookie.same_site.is_empty() {
            keys.push(NSHTTPCookieSameSitePolicy);
            values.push(&same_site);
        }
        if let Some(expiry) = expiry.as_ref() {
            keys.push(NSHTTPCookieExpires);
            values.push(expiry);
        }
        let native = NSHTTPCookie::cookieWithProperties(&NSDictionary::from_slices(&keys, &values))
            .ok_or("Cookie 属性不受 WebKit 支持")?;
        if native.isHTTPOnly() != cookie.http_only || native.isSecure() != cookie.secure {
            return Err("Cookie 安全属性不能保留，已停止导入".into());
        }
        if !cookie.same_site.is_empty()
            && !native
                .sameSitePolicy()
                .is_some_and(|policy| policy.to_string().eq_ignore_ascii_case(&cookie.same_site))
        {
            return Err("Cookie SameSite 属性不能保留，已停止导入".into());
        }
        Ok(native)
    }
}
/// Only called after native user confirmation. No cookie values cross IPC.
pub fn install_cookies(
    app: &AppHandle,
    cookies: Vec<Cookie>,
    expected_tab: u32,
) -> Result<usize, String> {
    if cookies.is_empty() {
        return Ok(0);
    }
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !state::snapshot(&handle)
            .tabs
            .iter()
            .any(|tab| tab.id == expected_tab)
        {
            let _ = tx.send(Err("导入目标浏览会话已变化".into()));
            return;
        }
        let store = REGISTRY.with(|registry| registry.borrow().store.clone());
        let Some(store) = store else {
            let _ = tx.send(Err("浏览会话已关闭".into()));
            return;
        };
        let prepared = cookies
            .iter()
            .map(native_cookie)
            .collect::<Result<Vec<_>, _>>();
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let _ = tx.send(Err(error));
                return;
            }
        };
        let count = prepared.len();
        let remaining = Arc::new(AtomicUsize::new(count));
        let destination = unsafe { store.httpCookieStore() };
        for cookie in prepared {
            let remaining = remaining.clone();
            let tx = tx.clone();
            let callback = RcBlock::new(move || {
                if remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
                    let _ = tx.send(Ok(count));
                }
            });
            unsafe {
                destination.setCookie_completionHandler(&cookie, Some(&callback));
            }
        }
    })
    .map_err(|_| "Cookie 导入调度失败")?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Cookie 导入超时，可能已部分写入".to_string())?
}

pub async fn fill(app: &AppHandle, entry: Entry) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let snapshot = state::snapshot(&handle);
        if snapshot.status != "ready" { let _ = tx.send(Err("请等待当前页面加载完成后再填充密码".into())); return; }
        let id = snapshot.active_tab_id;
        let view = REGISTRY.with(|registry| id.and_then(|id| registry.borrow().guests.get(&id).map(|guest| guest.view.clone())));
        let Some(view) = view else { let _ = tx.send(Err("没有活动网页".into())); return; };
        let current = unsafe { view.URL().and_then(|url| url.absoluteString()).map(|url| url.to_string()) };
        let matched = current.and_then(|url| url::Url::parse(&url).ok()).is_some_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == entry.origin);
        if !matched { let _ = tx.send(Err("密码只允许填入相同 HTTPS 来源的页面".into())); return; }
        // Fixed operation, current main frame only, no arbitrary script API or auto-submit.
        // Check origin again inside the page to protect against navigation between dispatch and execution.
        let values = Zeroizing::new(serde_json::to_string(&entry).unwrap_or_default());
        let script = Zeroizing::new(format!(r#"(() => {{
          const e = {};
          if (location.origin !== e.origin || location.protocol !== 'https:') return false;
          const p = document.querySelector('input[type="password"]');
          if (!p) return false;
          const root = p.form || document;
          const u = root.querySelector('input[autocomplete="username"],input[type="email"],input[type="text"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const put = (input,value) => {{ setter.call(input,value); input.dispatchEvent(new Event('input', {{bubbles:true}})); input.dispatchEvent(new Event('change', {{bubbles:true}})); }};
          if (u) put(u,e.username); put(p,e.password); return true;
        }})()"#, values.as_str()));
        let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut objc2_foundation::NSError| {
            let ok = error.is_null() && unsafe { value.as_ref() }.and_then(|value| value.downcast_ref::<NSNumber>()).is_some_and(|value| value.boolValue());
            let _ = tx.send(if ok { Ok(()) } else { Err("未找到可填充的登录表单，或页面已切换".into()) });
        });
        unsafe { view.evaluateJavaScript_completionHandler(&NSString::from_str(&script), Some(&callback)); }
    }).map_err(|_| "密码填充调度失败")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "密码填充未完成".to_string())?
    })
    .await
    .map_err(|_| "密码填充未完成".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic_cookie_retains_security_attributes() {
        let cookie = Cookie {
            host: ".example.test".into(),
            name: "synthetic".into(),
            value: "fixture-only".into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            expires: None,
            same_site: "Strict".into(),
        };
        let native = native_cookie(&cookie).unwrap();
        assert!(native.isSecure());
        assert!(native.isHTTPOnly());
        assert!(native.isSessionOnly());
        assert_eq!(native.sameSitePolicy().unwrap().to_string(), "strict");
    }
}
