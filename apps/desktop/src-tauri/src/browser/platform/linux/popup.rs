use gtk::prelude::*;
use tauri::{AppHandle, Manager};
use webkit2gtk::{URIRequestExt, WebView, WebViewExt};

pub(super) fn connect(app: &AppHandle, view: &WebView) {
    let app = app.clone();
    view.connect_create(move |opener, action| {
        if !action.is_user_gesture() {
            return None;
        }
        let url = action.request()?.uri()?;
        super::super::portable::popup::open(&app, &url, |id| {
            let view = WebView::builder()
                .related_view(opener)
                .user_content_manager(&super::content_manager())
                .build();
            let context = view.context().ok_or("新窗口数据上下文不可用")?;
            super::configure(&app, id, &view)?;
            let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
            let parent = super::viewport::parent(&window)?;
            parent.put(&view, 0, 0);
            view.hide();
            let handle = view.clone().upcast::<gtk::Widget>();
            Ok((
                Box::new(super::Guest {
                    app: app.clone(),
                    id,
                    view,
                    parent,
                    _context: context,
                }),
                handle,
            ))
        })
        .ok()
    });
}
