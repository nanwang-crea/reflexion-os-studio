use crate::browser::platform::portable::downloads;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use tauri::AppHandle;
use webkit2gtk::{DownloadExt, URIRequestExt, URIResponseExt, WebContext, WebContextExt};

pub(super) fn connect(app: &AppHandle, context: &WebContext) {
    let app = app.clone();
    context.connect_download_started(move |_, download| {
        let stage_path = Rc::new(RefCell::new(None::<std::path::PathBuf>));
        let destination_stage = stage_path.clone();
        let id = Rc::new(Cell::new(None));
        let destination_id = id.clone();
        let destination_app = app.clone();
        download.connect_decide_destination(move |download, filename| {
            let response = download.response().and_then(|response| response.uri());
            let request = download.request().and_then(|request| request.uri());
            let allowed =
                request
                    .as_ref()
                    .zip(response.as_ref())
                    .is_some_and(|(request, response)| {
                        url::Url::parse(request)
                            .ok()
                            .zip(url::Url::parse(response).ok())
                            .is_some_and(|(request, response)| {
                                request.origin() == response.origin()
                            })
                    });
            if !allowed {
                download.cancel();
                return true;
            }
            let Some(source) = response else {
                download.cancel();
                return true;
            };
            match downloads::prepare(&destination_app, &source, filename) {
                Ok((id, stage)) => {
                    let Ok(destination) = url::Url::from_file_path(&stage) else {
                        downloads::finish(id, false);
                        download.cancel();
                        return true;
                    };
                    *destination_stage.borrow_mut() = Some(stage);
                    destination_id.set(Some(id));
                    let cancel = download.clone();
                    downloads::cancellation(id, move || cancel.cancel());
                    download.set_allow_overwrite(false);
                    download.set_destination(destination.as_str());
                }
                Err(_) => {
                    download.cancel();
                }
            }
            true
        });
        let progress_id = id.clone();
        download.connect_received_data(move |download, _| {
            if let Some(id) = progress_id.get() {
                let total = download
                    .response()
                    .map(|response| response.content_length())
                    .filter(|length| *length > 0);
                downloads::progress(id, download.received_data_length(), total);
            }
        });
        let failed_id = id.clone();
        let failed_stage = stage_path.clone();
        download.connect_failed(move |_, _| {
            if let Some(id) = failed_id.get() {
                if let Some(stage) = &*failed_stage.borrow() {
                    downloads::settled(id, false, stage);
                }
            }
        });
        download.connect_finished(move |_| {
            if let Some(id) = id.get() {
                if let Some(stage) = &*stage_path.borrow() {
                    downloads::settled(id, true, stage);
                }
            }
        });
    });
}
