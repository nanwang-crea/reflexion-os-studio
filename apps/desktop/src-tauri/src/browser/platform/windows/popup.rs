use tauri::AppHandle;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, NewWindowRequestedEventHandler};
use windows::core::{Interface, BOOL};
use wry::{WebView, WebViewExtWindows};

pub(super) fn install(app: &AppHandle, view: &WebView) -> Result<(), String> {
    let app = app.clone();
    unsafe {
        let mut token = 0;
        view.webview()
            .add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |view, args| {
                    let (Some(view), Some(args)) = (view, args) else {
                        return Ok(());
                    };
                    args.SetHandled(true)?;
                    let mut gesture = BOOL::default();
                    args.IsUserInitiated(&mut gesture)?;
                    if !gesture.as_bool() {
                        return Ok(());
                    }
                    let url = super::navigation::text(|pointer| args.Uri(pointer))?;
                    let environment = view.cast::<ICoreWebView2_2>()?.Environment()?;
                    let _completion = super::deferral::Completion(args.GetDeferral()?);
                    let result = super::super::portable::popup::open(&app, &url, |id| {
                        let guest = super::build(&app, id, Some(environment))?;
                        let handle = guest.view.webview();
                        args.SetNewWindow(&handle).map_err(|_| "新窗口绑定失败")?;
                        Ok((Box::new(guest), handle))
                    });
                    let _ = result;
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|_| "无法安装新窗口隔离".to_string())?;
    }
    Ok(())
}
