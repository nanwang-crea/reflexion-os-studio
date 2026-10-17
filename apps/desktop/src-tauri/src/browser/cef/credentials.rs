//! User-confirmed native operations. Values never cross Runtime/Agent IPC.
use crate::browser::{
    import::{chromium::Cookie as ImportedCookie, vault::Entry},
    state,
};
use cef::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;
use tauri::AppHandle;
use zeroize::Zeroizing;
struct Completion {
    remaining: AtomicUsize,
    failed: AtomicUsize,
    count: usize,
    done: mpsc::Sender<Result<usize, String>>,
}
impl Completion {
    fn finish(&self, success: bool) {
        if !success {
            self.failed.fetch_add(1, Ordering::AcqRel);
        }
        if self.remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
            let _ = self.done.send(if self.failed.load(Ordering::Acquire) == 0 {
                Ok(self.count)
            } else {
                Err("Cookie 导入未全部成功，可能已部分写入".into())
            });
        }
    }
}
wrap_set_cookie_callback! {struct CookieDone {completion:Arc<Completion>} impl SetCookieCallback {fn on_complete(&self,success:i32){self.completion.finish(success!=0);}}}
fn native(cookie: &ImportedCookie) -> Result<Cookie, String> {
    let same_site = match cookie.same_site.to_ascii_lowercase().as_str() {
        "strict" => CookieSameSite::STRICT_MODE,
        "lax" => CookieSameSite::LAX_MODE,
        "none" => CookieSameSite::NO_RESTRICTION,
        "" => CookieSameSite::UNSPECIFIED,
        _ => return Err("Cookie SameSite 无效".into()),
    };
    Ok(Cookie {
        name: CefString::from(cookie.name.as_str()),
        value: CefString::from(cookie.value.as_str()),
        domain: CefString::from(cookie.host.as_str()),
        path: CefString::from(cookie.path.as_str()),
        secure: cookie.secure as i32,
        httponly: cookie.http_only as i32,
        has_expires: cookie.expires.is_some() as i32,
        expires: Basetime {
            val: cookie
                .expires
                .map(|s| (s * 1_000_000.0) as i64 + 11_644_473_600_000_000)
                .unwrap_or_default(),
        },
        same_site,
        ..Default::default()
    })
}
pub fn install_cookies(
    app: &AppHandle,
    cookies: Vec<ImportedCookie>,
    expected_tab: u32,
) -> Result<usize, String> {
    if cookies.is_empty() {
        return Ok(0);
    }
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    super::dispatch(move || {
        let result = (|| {
            if state::snapshot(&handle).active_tab_id != Some(expected_tab) {
                return Err("导入目标浏览会话已变化".into());
            }
            super::registry::active_user(&handle)?;
            let manager = super::registry::user_context()
                .and_then(|c| c.cookie_manager(None))
                .ok_or("浏览会话已关闭")?;
            let prepared = cookies.iter().map(native).collect::<Result<Vec<_>, _>>()?;
            let completion = Arc::new(Completion {
                remaining: AtomicUsize::new(cookies.len() + 1),
                failed: AtomicUsize::new(0),
                count: cookies.len(),
                done: tx.clone(),
            });
            for (cookie, native) in cookies.iter().zip(prepared) {
                let source = format!(
                    "{}://{}{}",
                    if cookie.secure { "https" } else { "http" },
                    cookie.host.trim_start_matches('.'),
                    cookie.path
                );
                let mut callback = CookieDone::new(completion.clone());
                if manager.set_cookie(
                    Some(&CefString::from(source.as_str())),
                    Some(&native),
                    Some(&mut callback),
                ) == 0
                {
                    completion.finish(false);
                }
            }
            completion.finish(true);
            Ok(())
        })();
        if let Err(error) = result {
            let _ = tx.send(Err(error));
        }
    })
    .map_err(|_| "Cookie 导入调度失败")?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Cookie 导入超时，可能已部分写入".to_string())?
}
pub async fn fill(app: &AppHandle, entry: Entry) -> Result<(), String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel();
    super::dispatch(move || {
        let result=(|| {
            let snapshot=state::snapshot(&handle);
            if snapshot.status!="ready" {return Err("请等待页面加载完成".into());}
            let browser=super::registry::active_user(&handle)?;
            let frame=browser.main_frame().ok_or("没有活动网页")?;
            let current=CefString::from(&frame.url()).to_string();
            if !url::Url::parse(&current).ok().is_some_and(|u|u.scheme()=="https" && u.origin().ascii_serialization()==entry.origin) {return Err("密码只允许填入相同 HTTPS 来源的页面".into());}
            let values=Zeroizing::new(serde_json::to_string(&entry).map_err(|_|"填充数据无效")?);
            let script=Zeroizing::new(format!(r#"(() => {{const e={};if(location.protocol!=='https:'||location.origin!==e.origin)return;const p=document.querySelector('input[type="password"]');if(!p)return;const u=(p.form||document).querySelector('input[autocomplete="username"],input[type="email"],input[type="text"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;const put=(i,v)=>{{set.call(i,v);i.dispatchEvent(new Event('input',{{bubbles:true}}));i.dispatchEvent(new Event('change',{{bubbles:true}}));}};if(u)put(u,e.username);put(p,e.password);}})()"#,values.as_str()));
            frame.execute_java_script(Some(&CefString::from(script.as_str())),None,0);
            if let Some(id)=snapshot.active_tab_id {state::update_tab(&handle,id,|tab|tab.notice=Some("已请求填充密码，请检查页面；不会自动提交".into()));} Ok(())
        })();let _=tx.send(result);
    }).map_err(|_|"密码填充调度失败")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "密码填充未完成".to_string())?
    })
    .await
    .map_err(|_| "密码填充未完成".to_string())?
}
