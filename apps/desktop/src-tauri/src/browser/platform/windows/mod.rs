//! Plain Wry child: no Tauri scripts, custom protocols, IPC or host objects.
mod deferral;
mod downloads;
mod navigation;
mod permissions;
mod popup;
mod storage;
use super::portable::{Bounds, Engine};
use crate::browser::state::{self, Action};
use tauri::{AppHandle, Manager};
use wry::{
    dpi::LogicalPosition, dpi::LogicalSize, Rect, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

struct Guest {
    app: AppHandle,
    id: u32,
    view: WebView,
    _context: WebContext,
    _directory: std::path::PathBuf,
}

pub(super) fn create(app: &AppHandle, id: u32) -> Result<Box<dyn Engine>, String> {
    build(app, id, None).map(|guest| Box::new(guest) as Box<dyn Engine>)
}
fn build(
    app: &AppHandle,
    id: u32,
    environment: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment>,
) -> Result<Guest, String> {
    // Never use WebView2's default user-data folder (which belongs to the Renderer).
    let directory = storage::directory(app)?;
    let mut context = WebContext::new(Some(directory.clone()));
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    let nav_app = app.clone();
    let title_app = app.clone();
    let mut builder = WebViewBuilder::new_with_web_context(&mut context);
    if let Some(environment) = environment {
        builder = builder.with_environment(environment);
    }
    let view = builder
        .with_incognito(state::preferences(app).storage_mode == "temporary")
        .with_initialization_script(include_str!("../initial-position.js"))
        .with_visible(false)
        .with_devtools(false)
        .with_clipboard(false)
        .with_general_autofill_enabled(false)
        .with_drag_drop_handler(|_| true)
        .with_navigation_handler(move |url| super::portable::navigation_allowed(&nav_app, &url))
        .with_document_title_changed_handler(move |title| {
            if !title.is_empty() {
                state::update_tab(&title_app, id, |tab| tab.title = title.clone());
            }
        })
        .build_as_child(&window)
        .map_err(|_| "WebView2 浏览视图创建失败")?;
    permissions::install(&view, state::preferences(app).storage_mode == "temporary")?;
    storage::remember(
        &view,
        &directory,
        state::preferences(app).storage_mode == "temporary",
    )?;
    navigation::install(app, id, &view)?;
    downloads::install(app, &view)?;
    popup::install(app, &view)?;
    Ok(Guest {
        app: app.clone(),
        id,
        view,
        _context: context,
        _directory: directory,
    })
}

pub(super) fn dispose() {
    storage::dispose();
}

impl Engine for Guest {
    fn control(&self, action: &Action) -> Result<(), String> {
        let result = match action {
            Action::Navigate { url } => self.view.load_url(url),
            Action::Zoom { factor } => self.view.zoom(*factor),
            Action::Print => self.view.print(),
            Action::Fillcontact { contact } => {
                if let Some(script) = super::portable::contact::script(&self.app, self.id, contact)?
                {
                    let app = self.app.clone();
                    let id = self.id;
                    self.view
                        .evaluate_script_with_callback(&script, move |result| {
                            super::portable::contact::completed(&app, id, result == "true");
                        })
                } else {
                    return Ok(());
                }
            }
            Action::Find { text, backwards } => self.view.evaluate_script(&format!(
                "window.find({},false,{},true,false,false,false)",
                serde_json::to_string(text).map_err(|_| "查找输入无效")?,
                backwards
            )),
            Action::Back => unsafe { self.view.webview().GoBack() }.map_err(wry::Error::from),
            Action::Forward => unsafe { self.view.webview().GoForward() }.map_err(wry::Error::from),
            Action::Reload => unsafe { self.view.webview().Reload() }.map_err(wry::Error::from),
            Action::Stop => unsafe { self.view.webview().Stop() }.map_err(wry::Error::from),
            Action::Status => return Ok(()),
            _ => return Err("本平台该浏览器能力尚不可用".into()),
        };
        result.map_err(|_| "WebView2 网页操作失败".into())
    }
    fn layout(&self, bounds: Bounds, visible: bool) -> Result<(), String> {
        self.view
            .set_bounds(Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(bounds.width, bounds.height).into(),
            })
            .map_err(|_| "网页视口布局失败")?;
        self.view
            .set_visible(visible)
            .map_err(|_| "网页显隐失败".into())
    }
    fn stop(&self) {
        let _ = unsafe { self.view.webview().Stop() };
    }
}

pub(super) use storage::clear_data;
