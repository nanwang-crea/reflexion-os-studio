//! Native request/permission checks also cover traffic outside Playwright routing.
use super::registry::Policy;
use cef::*;
use std::sync::Arc;

impl Policy {
    pub fn allows(&self, raw: &str, _method: &str) -> bool {
        if raw == "about:blank" || raw.starts_with("about:blank#") {
            return true;
        }
        if self.origin.is_some()
            && !self
                .network_ready
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return false;
        }
        let Ok(mut url) = url::Url::parse(raw) else {
            return false;
        };
        if matches!(url.scheme(), "data" | "blob") {
            return true;
        }
        let protocol = match url.scheme() {
            "ws" => "http",
            "wss" => "https",
            "http" => "http",
            "https" => "https",
            _ => return false,
        };
        let protocol = protocol.to_owned();
        if url.set_scheme(&protocol).is_err() {
            return false;
        }
        crate::browser::policy::guest_url(url.as_str(), self.dev_url.as_ref()).is_ok()
    }
    pub fn allows_navigation(&self, raw: &str, method: &str) -> bool {
        (raw.starts_with("about:blank")
            || url::Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "http" | "https")))
            && self.allows(raw, method)
    }
}
wrap_request_handler! {
    pub struct Requests { policy: Arc<Policy>, app:tauri::AppHandle, tab:u32 }
    impl RequestHandler {
        fn on_render_process_terminated(&self,_browser:Option<&mut Browser>,_status:TerminationStatus,_code:i32,_error:Option<&CefString>) {crate::browser::state::update_tab(&self.app,self.tab,|tab|{tab.status="failed".into();tab.notice=Some("网页进程已停止，请刷新或重新打开".into());});}
        fn on_before_browse(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,request:Option<&mut Request>,_gesture:i32,_redirect:i32)->i32 {
            request.is_none_or(|request| { let url=CefString::from(&request.url()).to_string();let method=CefString::from(&request.method()).to_string(); if _frame.is_some_and(|frame|frame.is_main()==1) {!self.policy.allows_navigation(&url,&method)} else {!self.policy.allows(&url,&method)} }) as i32
        }
        fn resource_request_handler(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_request:Option<&mut Request>,_navigation:i32,_download:i32,_initiator:Option<&CefString>,_handling:Option<&mut i32>)->Option<ResourceRequestHandler> {Some(Resources::new(self.policy.clone()))}
    }
}
wrap_resource_request_handler! {
    struct Resources { policy: Arc<Policy> }
    impl ResourceRequestHandler {
        fn on_before_resource_load(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,request:Option<&mut Request>,_callback:Option<&mut Callback>)->ReturnValue {
            if request.is_some_and(|request| self.policy.allows(&CefString::from(&request.url()).to_string(),&CefString::from(&request.method()).to_string())) {ReturnValue::CONTINUE} else {ReturnValue::CANCEL}
        }
    }
}
wrap_permission_handler! {
    pub struct Permissions;
    impl PermissionHandler {
        fn on_request_media_access_permission(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_origin:Option<&CefString>,_permissions:u32,callback:Option<&mut MediaAccessCallback>)->i32 { if let Some(callback)=callback {callback.cancel();} 1 }
        fn on_show_permission_prompt(&self,_browser:Option<&mut Browser>,_id:u64,_origin:Option<&CefString>,_permissions:u32,callback:Option<&mut PermissionPromptCallback>)->i32 {if let Some(callback)=callback {callback.cont(PermissionRequestResult::DENY);} 1}
    }
}
wrap_dialog_handler! {
    pub struct Dialogs;
    impl DialogHandler {
        fn on_file_dialog(&self,_browser:Option<&mut Browser>,_mode:FileDialogMode,_title:Option<&CefString>,_path:Option<&CefString>,_filters:Option<&mut CefStringList>,_extensions:Option<&mut CefStringList>,_descriptions:Option<&mut CefStringList>,callback:Option<&mut FileDialogCallback>)->i32 { if let Some(callback)=callback {callback.cancel();} 1}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn agent(ready: bool) -> Policy {
        Policy {
            origin: Some("https://example.test".into()),
            dev_url: None,
            locked: AtomicBool::new(true),
            network_ready: AtomicBool::new(ready),
        }
    }
    #[test]
    fn agent_network_initializes_before_normal_cross_origin_requests() {
        let policy = agent(false);
        assert!(policy.allows("about:blank#lease", "GET"));
        assert!(!policy.allows("https://example.test/", "GET"));
        let policy = agent(true);
        for (url, method) in [
            ("https://other.test/", "GET"),
            ("https://example.test/", "POST"),
            ("wss://other.test/", "GET"),
            ("data:image/png;base64,AAAA", "GET"),
            ("blob:https://example.test/id", "GET"),
        ] {
            assert!(policy.allows(url, method));
        }
        for url in [
            "file:///tmp/fixture",
            "https://u:p@example.test/",
            "tauri://localhost/",
        ] {
            assert!(!policy.allows(url, "GET"));
        }
        assert!(!policy.allows_navigation("data:text/html,example", "GET"));
    }
    #[test]
    fn agent_cannot_use_system_network_to_open_application_origins() {
        for origin in [
            "http://127.0.0.1:5173",
            "https://tauri.localhost",
            "https://ipc.localhost",
            "https://asset.localhost",
        ] {
            let mut policy = agent(true);
            policy.origin = Some(origin.into());
            policy.dev_url = Some(url::Url::parse("http://localhost:5173").unwrap());
            assert!(!policy.allows(&format!("{origin}/"), "GET"));
        }
    }
    #[test]
    fn agent_no_longer_rejects_fake_ip_addresses_by_range() {
        let mut policy = agent(true);
        policy.origin = Some("http://198.18.0.25".into());
        assert!(policy.allows("http://198.18.0.25/", "GET"));
        assert!(policy.allows("http://198.18.0.25/", "POST"));
    }
    #[test]
    fn user_webpages_cannot_navigate_to_application_origins() {
        let policy = Policy {
            origin: None,
            dev_url: Some(url::Url::parse("http://localhost:5173").unwrap()),
            locked: AtomicBool::new(false),
            network_ready: AtomicBool::new(true),
        };
        assert!(!policy.allows("http://localhost:5173/", "GET"));
        assert!(!policy.allows("http://127.0.0.1:5173/", "GET"));
        assert!(!policy.allows("https://tauri.localhost/", "GET"));
        assert!(policy.allows("https://example.test/", "POST"));
    }
}
