use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
use windows::core::Interface;
use wry::{WebView, WebViewExtWindows};

pub(super) fn install(view: &WebView, temporary: bool) -> Result<(), String> {
    let install = || -> windows::core::Result<()> {
        let webview = view.webview();
        unsafe {
            // Older runtimes silently ignore Wry's incognito flag. Verify it natively.
            let profile = webview.cast::<ICoreWebView2_13>()?.Profile()?;
            let mut private = windows::core::BOOL::default();
            profile.IsInPrivateModeEnabled(&mut private)?;
            if private.as_bool() != temporary {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004005u32 as i32,
                )));
            }
            let settings = webview.Settings()?;
            settings.SetIsWebMessageEnabled(false)?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetAreDefaultScriptDialogsEnabled(false)?;
            let autofill = settings.cast::<ICoreWebView2Settings4>()?;
            autofill.SetIsPasswordAutosaveEnabled(false)?;
            autofill.SetIsGeneralAutofillEnabled(false)?;
            let mut token = 0;
            webview.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    };
    install().map_err(|_| "WebView2 无法安装权限隔离，拒绝创建网页".into())
}
