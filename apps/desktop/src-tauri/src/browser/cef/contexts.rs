//! Context initialization must finish before changing Chromium preferences.
use super::registry::Policy;
use crate::browser::state;
use cef::*;
use std::sync::{atomic::Ordering, Arc};
wrap_request_context_handler! {
    struct AgentContext { policy:Arc<Policy>, proxy:String }
    impl RequestContextHandler {
        fn on_request_context_initialized(&self, context:Option<&mut RequestContext>) {
            let Some(context)=context else{return;};
            let proxy=serde_json::json!({"mode":"fixed_servers","server":self.proxy,"bypass_list":"<-loopback>"});
            let Some(mut value)=parse_json(Some(&CefString::from(proxy.to_string().as_str())),JsonParserOptions::default()) else{return;};
            // A default CefString is a null pointer, not a writable output string.
            let mut error=CefString::from("");
            let success=context.set_preference(Some(&CefString::from("proxy")),Some(&mut value),Some(&mut error))==1;
            self.policy.proxy_ready.store(success,Ordering::Release);
        }
    }
}
pub fn agent(policy: Arc<Policy>, proxy: String) -> Result<RequestContext, String> {
    let mut handler = AgentContext::new(policy, proxy);
    request_context_create_context(Some(&RequestContextSettings::default()), Some(&mut handler))
        .ok_or_else(|| "browser_unavailable".into())
}
pub fn user(app: &tauri::AppHandle) -> Result<RequestContext, String> {
    if let Some(context) = super::registry::user_context() {
        return Ok(context);
    }
    let settings = RequestContextSettings {
        cache_path: if state::preferences(app).storage_mode == "persistent" {
            CefString::from(
                super::storage::user(app)?
                    .to_str()
                    .ok_or("invalid CEF profile path")?,
            )
        } else {
            CefString::default()
        },
        ..Default::default()
    };
    let context =
        request_context_create_context(Some(&settings), None).ok_or("CEF context unavailable")?;
    super::registry::set_user_context(context.clone());
    Ok(context)
}
