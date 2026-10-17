use super::registry::Policy;
use crate::browser::state;
use cef::*;
use std::sync::Arc;

wrap_client! {
    pub struct GuestClient { app: tauri::AppHandle, tab: u32, policy: Arc<Policy> }
    impl Client {
        fn context_menu_handler(&self)->Option<ContextMenuHandler> {Some(ContextMenu::new())}
        fn display_handler(&self) -> Option<DisplayHandler> { Some(Display::new(self.app.clone(),self.tab)) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(Load::new(self.app.clone(),self.tab)) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(super::network::Requests::new(self.policy.clone(),self.app.clone(),self.tab)) }
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(super::network::Permissions::new()) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Lifetime::new(self.app.clone(),self.tab,self.policy.clone())) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(super::downloads::Downloads::new(self.app.clone(),self.tab,self.policy.clone())) }
        fn dialog_handler(&self) -> Option<DialogHandler> { Some(super::network::Dialogs::new()) }
    }
}
wrap_display_handler! {
    struct Display { app: tauri::AppHandle, tab: u32 }
    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(ToString::to_string).unwrap_or_else(|| "新标签页".into());
            state::update_tab(&self.app,self.tab, |tab| tab.title = title);
        }
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                let url = url.map(ToString::to_string).filter(|url| url.starts_with("http://") || url.starts_with("https://"));
                state::update_tab(&self.app,self.tab,|tab| tab.url = url);
            }
        }
        fn on_loading_progress_change(&self, _browser: Option<&mut Browser>, progress: f64) {
            state::update_tab(&self.app,self.tab,|tab| tab.progress = progress.clamp(0.0,1.0));
        }
    }
}
wrap_load_handler! {
    struct Load { app: tauri::AppHandle, tab: u32 }
    impl LoadHandler {
        fn on_loading_state_change(&self,_browser:Option<&mut Browser>,loading:i32,back:i32,forward:i32) {
            state::update_tab(&self.app,self.tab,|tab| { tab.status = if loading != 0 {"loading"} else {"ready"}.into(); tab.can_go_back=back!=0; tab.can_go_forward=forward!=0; if loading==0 {tab.progress=1.0;} });
        }
        fn on_load_error(&self,_browser:Option<&mut Browser>,frame:Option<&mut Frame>,code:Errorcode,_text:Option<&CefString>,_url:Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main()!=0) && code != Errorcode::ABORTED {
                state::update_tab(&self.app,self.tab,|tab| {tab.status="failed".into();tab.notice=Some("网页加载失败，可重试或更换地址".into());});
            }
        }
    }
}
wrap_life_span_handler! {
    struct Lifetime { app: tauri::AppHandle, tab: u32, policy: Arc<Policy> }
    impl LifeSpanHandler {
        fn on_after_created(&self,browser:Option<&mut Browser>) {super::created(self.tab);if let Some(host)=browser.and_then(|b|b.host()){host.set_accessibility_state(State::ENABLED);}}
        fn do_close(&self,_browser:Option<&mut Browser>)->i32 {
            // Detach only CEF's child, after this callback; its parent stays owned
            // until OnBeforeClose and the remaining CEF stack have returned.
            super::viewport::destroy(self.tab);
            1
        }
        fn on_before_close(&self,_browser:Option<&mut Browser>) {
            super::registry::closed(&self.app,self.tab);
            let app=self.app.clone();let id=self.tab;
            super::pump::defer(move || {super::input::remove(id);super::closed(app,id);});
        }

        fn on_before_popup(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_id:i32,url:Option<&CefString>,_name:Option<&CefString>,_disposition:WindowOpenDisposition,_gesture:i32,_features:Option<&PopupFeatures>,_info:Option<&mut WindowInfo>,_client:Option<&mut Option<Client>>,_settings:Option<&mut BrowserSettings>,_extra:Option<&mut Option<DictionaryValue>>,_access:Option<&mut i32>) -> i32 {
            if self.policy.origin.is_none() {
                if let Some(url) = url.map(ToString::to_string).filter(|url| crate::browser::policy::guest_url(url,crate::browser::policy::dev_url(&self.app)).is_ok()) {
                    super::popup::open(self.app.clone(), self.tab, url);
                }
            }
            1
        }
    }
}

// File saving and developer windows must use trusted browser chrome, never CEF defaults.
wrap_context_menu_handler! {struct ContextMenu; impl ContextMenuHandler {
    fn on_before_context_menu(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_params:Option<&mut ContextMenuParams>,model:Option<&mut MenuModel>) {if let Some(model)=model {model.clear();}}
}}
