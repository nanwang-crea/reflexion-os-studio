//! WebKitGTK guest sharing neither context nor user-content manager with the Renderer.
mod downloads;
mod navigation;
mod popup;
mod storage;
mod viewport;
use super::portable::{Bounds, Engine};
use crate::browser::state::Action;
use gtk::prelude::*;
use javascriptcore::ValueExt;
use tauri::{AppHandle, Manager};
use webkit2gtk::{
    FileChooserRequestExt, FindControllerExt, PermissionRequestExt, PrintOperationExt, SettingsExt,
    UserContentInjectedFrames, UserContentManager, UserContentManagerExt, UserScript,
    UserScriptInjectionTime, WebContext, WebView, WebViewExt,
};

struct Guest {
    app: AppHandle,
    id: u32,
    view: WebView,
    parent: gtk::Fixed,
    _context: WebContext,
}

pub(super) fn create(app: &AppHandle, id: u32) -> Result<Box<dyn Engine>, String> {
    let context = storage::context(app)?;
    let view = WebView::builder()
        .web_context(&context)
        .user_content_manager(&content_manager())
        .build();
    configure(app, id, &view)?;
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    let parent = viewport::parent(&window)?;
    parent.put(&view, 0, 0);
    view.hide();
    Ok(Box::new(Guest {
        app: app.clone(),
        id,
        view,
        parent,
        _context: context,
    }))
}

fn content_manager() -> UserContentManager {
    let manager = UserContentManager::new();
    manager.add_script(&UserScript::new(
        include_str!("../initial-position.js"),
        UserContentInjectedFrames::TopFrame,
        UserScriptInjectionTime::Start,
        &[],
        &[],
    ));
    manager
}

fn configure(app: &AppHandle, id: u32, view: &WebView) -> Result<(), String> {
    let settings = webkit2gtk::WebViewExt::settings(view).ok_or("WebKitGTK 设置不可用")?;
    settings.set_enable_developer_extras(false);
    settings.set_javascript_can_access_clipboard(false);
    settings.set_javascript_can_open_windows_automatically(false);
    settings.set_enable_html5_database(false);
    view.connect_permission_request(|_, request| {
        request.deny();
        true
    });
    view.connect_run_file_chooser(|_, request| {
        request.cancel();
        true
    });
    view.connect_drag_drop(|_, context, _, _, time| {
        context.drag_finish(false, false, time);
        true
    });
    view.connect_script_dialog(|_, dialog| {
        if matches!(
            dialog.dialog_type(),
            webkit2gtk::ScriptDialogType::Confirm
                | webkit2gtk::ScriptDialogType::BeforeUnloadConfirm
        ) {
            dialog.confirm_set_confirmed(false);
        }
        dialog.close();
        true
    });
    navigation::connect(app, id, view);
    popup::connect(app, view);
    Ok(())
}

impl Engine for Guest {
    fn control(&self, action: &Action) -> Result<(), String> {
        match action {
            Action::Navigate { url } => self.view.load_uri(url),
            Action::Back => self.view.go_back(),
            Action::Forward => self.view.go_forward(),
            Action::Reload => self.view.reload(),
            Action::Stop => self.view.stop_loading(),
            Action::Zoom { factor } => self.view.set_zoom_level(*factor),
            Action::Fillcontact { contact } => {
                if let Some(script) = super::portable::contact::script(&self.app, self.id, contact)?
                {
                    let app = self.app.clone();
                    let id = self.id;
                    let revision = script.revision;
                    self.view.evaluate_javascript(
                        &script.source,
                        None,
                        None,
                        None::<&webkit2gtk::gio::Cancellable>,
                        move |result| {
                            super::portable::contact::completed(
                                &app,
                                id,
                                revision,
                                result.is_ok_and(|value| value.is_boolean() && value.to_boolean()),
                            );
                        },
                    );
                }
            }
            Action::Find { text, backwards } => {
                let controller = self.view.find_controller().ok_or("查找不可用")?;
                let mut options = webkit2gtk::FindOptions::WRAP_AROUND;
                if *backwards {
                    options |= webkit2gtk::FindOptions::BACKWARDS;
                }
                controller.search(text, options.bits(), u32::MAX);
            }
            Action::Print => {
                let operation = webkit2gtk::PrintOperation::new(&self.view);
                operation.run_dialog(gtk::Window::NONE);
            }
            Action::Status => {}
            _ => return Err("本平台该浏览器能力尚不可用".into()),
        }
        Ok(())
    }
    fn layout(&self, bounds: Bounds, visible: bool) -> Result<(), String> {
        self.parent
            .move_(&self.view, bounds.x.round() as i32, bounds.y.round() as i32);
        self.view
            .set_size_request(bounds.width.round() as i32, bounds.height.round() as i32);
        self.view.set_visible(visible);
        Ok(())
    }
    fn stop(&self) {
        self.view.stop_loading();
    }
}
impl Drop for Guest {
    fn drop(&mut self) {
        self.parent.remove(&self.view);
    }
}

pub(super) fn dispose() {
    storage::dispose();
}

pub(super) use storage::clear_data;
