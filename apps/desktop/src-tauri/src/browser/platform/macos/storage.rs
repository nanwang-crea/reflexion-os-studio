use super::registry::REGISTRY;
use crate::browser::state;
use block2::RcBlock;
use objc2::{rc::Retained, AnyThread};
use objc2_foundation::{MainThreadMarker, NSDate, NSSet, NSString, NSUUID};
use objc2_web_kit::WKWebsiteDataStore;
use sha2::{Digest, Sha256};
use std::sync::mpsc::Sender;
use tauri::{AppHandle, Manager};

pub fn store(
    app: &AppHandle,
    marker: MainThreadMarker,
) -> Result<Retained<WKWebsiteDataStore>, String> {
    if let Some(store) = REGISTRY.with(|r| r.borrow().store.clone()) {
        return Ok(store);
    }
    let preferences = state::preferences(app);
    let store = if preferences.storage_mode == "persistent" {
        if !super::persistent_available() {
            return Err("持久配置需要 macOS 14 或更新系统".into());
        }
        let identity = std::env::var("REFLEXION_DATA_DIR").unwrap_or_else(|_| {
            app.path()
                .app_data_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        let hash = Sha256::digest(format!("reflexion-browser-profile-v1:{identity}"));
        let hex = hash[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let uuid = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let identifier = NSUUID::initWithUUIDString(NSUUID::alloc(), &NSString::from_str(&uuid))
            .ok_or("浏览配置标识无效")?;
        unsafe { WKWebsiteDataStore::dataStoreForIdentifier(&identifier, marker) }
    } else {
        unsafe { WKWebsiteDataStore::nonPersistentDataStore(marker) }
    };
    REGISTRY.with(|r| r.borrow_mut().store = Some(store.clone()));
    Ok(store)
}
pub fn clear(app: &AppHandle, website_data: bool, cache: bool, done: Sender<Result<(), String>>) {
    let failure = done.clone();
    let result = (|| {
        if super::clearing() {
            return Err("浏览数据正在清理".into());
        }
        let marker = MainThreadMarker::new().ok_or("清理必须在主线程执行")?;
        let store = store(app, marker)?;
        // Stop and dispose views before removal; pages cannot recreate data while clearing.
        crate::browser::window::control(app, state::Action::Close)?;
        REGISTRY.with(|r| {
            let mut r = r.borrow_mut();
            r.store = Some(store.clone());
            r.clearing = true;
        });
        unsafe {
            let all = WKWebsiteDataStore::allWebsiteDataTypes(marker);
            let types = all
                .iter()
                .filter(|kind| {
                    let name = kind.to_string();
                    let is_cache = name.contains("Cache") || name.contains("cache");
                    (website_data && !is_cache) || (cache && is_cache)
                })
                .collect::<Vec<_>>();
            let refs = types.iter().map(|kind| &**kind).collect::<Vec<_>>();
            let completion = RcBlock::new(move || {
                REGISTRY.with(|r| r.borrow_mut().clearing = false);
                let _ = done.send(Ok(()));
            });
            store.removeDataOfTypes_modifiedSince_completionHandler(
                &NSSet::from_slice(&refs),
                &NSDate::distantPast(),
                &completion,
            );
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = failure.send(Err(error));
    }
}
