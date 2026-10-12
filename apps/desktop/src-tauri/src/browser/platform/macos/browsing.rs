use block2::RcBlock;
use objc2_app_kit::NSPrintInfo;
use objc2_foundation::{MainThreadMarker, NSString};
use objc2_web_kit::{WKFindConfiguration, WKWebView};
use tauri::AppHandle;

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
