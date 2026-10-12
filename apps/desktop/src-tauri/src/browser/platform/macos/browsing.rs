use block2::RcBlock;
use objc2_app_kit::NSPrintInfo;
use objc2_foundation::{MainThreadMarker, NSString};
use objc2_web_kit::{WKFindConfiguration, WKWebView};
use tauri::AppHandle;

pub(super) fn center_initial_content(id: u32, view: &WKWebView) {
    let web_page = unsafe { view.URL().and_then(|url| url.absoluteString()) }
        .is_some_and(|url| crate::browser::policy::web_url(&url.to_string()).is_ok());
    if !web_page {
        return;
    }
    let pending = super::registry::REGISTRY.with(|registry| {
        registry
            .borrow_mut()
            .guests
            .get_mut(&id)
            .is_some_and(|guest| std::mem::take(&mut guest.initial_position_pending))
    });
    if pending {
        // A one-shot scroll only: no CSS changes, IPC or webpage content returned to the app.
        unsafe {
            view.evaluateJavaScript_completionHandler(
                &NSString::from_str(include_str!("../initial-position.js")),
                None,
            );
        }
    }
}

pub fn find(view: &WKWebView, text: &str, backwards: bool) -> Result<(), String> {
    let marker = MainThreadMarker::new().ok_or("查找必须在主线程执行")?;
    let config = unsafe { WKFindConfiguration::new(marker) };
    unsafe {
        config.setBackwards(backwards);
        config.setWraps(true);
        view.findString_withConfiguration_completionHandler(
            &NSString::from_str(text),
            Some(&config),
            &RcBlock::new(|_| {}),
        );
    }
    Ok(())
}
pub fn print(view: &WKWebView, _app: &AppHandle) -> Result<(), String> {
    let _marker = MainThreadMarker::new().ok_or("打印必须在主线程执行")?;
    unsafe {
        let operation = view.printOperationWithPrintInfo(&NSPrintInfo::sharedPrintInfo());
        operation.setShowsPrintPanel(true);
        operation.setShowsProgressPanel(true);
        operation.runOperation();
    }
    Ok(())
}
