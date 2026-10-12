use crate::browser::platform::portable::clearing;
use std::{cell::RefCell, sync::mpsc::Sender};
use tauri::{AppHandle, Manager};
use webkit2gtk::{
    WebContext, WebContextExt, WebsiteDataManager, WebsiteDataManagerExt,
    WebsiteDataManagerExtManual, WebsiteDataTypes,
};
thread_local! { static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) }; }

pub(super) fn context(app: &AppHandle) -> Result<WebContext, String> {
    CONTEXT.with(|context| {
        let mut context = context.borrow_mut();
        if let Some(context) = &*context {
            return Ok(context.clone());
        }
        let manager = if crate::browser::state::preferences(app).storage_mode == "persistent" {
            let data = std::env::var_os("REFLEXION_DATA_DIR")
                .map(std::path::PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_data_dir())
                .map_err(|_| "浏览数据目录不可用")?
                .join("browser-profile");
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(|_| "浏览缓存目录不可用")?
                .join("browser-profile");
            std::fs::create_dir_all(&data).map_err(|_| "浏览数据目录创建失败")?;
            std::fs::create_dir_all(&cache).map_err(|_| "浏览缓存目录创建失败")?;
            WebsiteDataManager::builder()
                .base_data_directory(data.to_string_lossy().as_ref())
                .base_cache_directory(cache.to_string_lossy().as_ref())
                .build()
        } else {
            WebsiteDataManager::new_ephemeral()
        };
        manager.set_tls_errors_policy(webkit2gtk::TLSErrorsPolicy::Fail);
        let next = WebContext::with_website_data_manager(&manager);
        super::downloads::connect(app, &next);
        *context = Some(next.clone());
        Ok(next)
    })
}

pub(super) fn dispose() {
    if !clearing::active() {
        CONTEXT.with(|context| {
            context.borrow_mut().take();
        });
    }
}

pub(crate) fn clear_data(
    app: &AppHandle,
    website_data: bool,
    cache: bool,
    done: Sender<Result<(), String>>,
) {
    let result = context(app).and_then(|context| {
        context
            .website_data_manager()
            .ok_or("网站数据管理不可用".into())
    });
    let manager = match result {
        Ok(manager) => manager,
        Err(error) => {
            let _ = done.send(Err(error));
            return;
        }
    };
    if let Err(error) = clearing::begin(app) {
        let _ = done.send(Err(error));
        return;
    }
    let caches = WebsiteDataTypes::DISK_CACHE
        | WebsiteDataTypes::MEMORY_CACHE
        | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
        | WebsiteDataTypes::DOM_CACHE
        | WebsiteDataTypes::HSTS_CACHE;
    let mut selected = WebsiteDataTypes::empty();
    if cache {
        selected |= caches;
    }
    if website_data {
        selected |= WebsiteDataTypes::ALL & !caches;
    }
    manager.clear(
        selected,
        webkit2gtk::glib::TimeSpan(0),
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            clearing::finish();
            let _ = done.send(result.map_err(|_| "网站数据清理失败".into()));
        },
    );
}
