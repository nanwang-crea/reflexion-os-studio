use crate::browser::platform::portable::downloads;
use tauri::AppHandle;
use webview2_com::{
    BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
    Microsoft::Web::WebView2::Win32::*, StateChangedEventHandler,
};
use windows::core::{Interface, PCWSTR};
use wry::{WebView, WebViewExtWindows};

pub(super) fn install(app: &AppHandle, view: &WebView) -> Result<(), String> {
    let app = app.clone();
    let install = || -> windows::core::Result<()> {
        let engine = view.webview().cast::<ICoreWebView2_4>()?;
        unsafe {
            let mut token = 0;
            engine.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    args.SetCancel(true)?;
                    args.SetHandled(true)?;
                    let _completion = super::deferral::Completion(args.GetDeferral()?);
                    let operation = args.DownloadOperation()?;
                    let source = super::navigation::text(|pointer| operation.Uri(pointer))?;
                    let suggested =
                        super::navigation::text(|pointer| args.ResultFilePath(pointer))?;
                    let name = std::path::Path::new(&suggested)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    let Ok((id, stage)) = downloads::prepare(&app, &source, &name) else {
                        return Ok(());
                    };
                    let cancel = operation.clone();
                    if !downloads::cancellation(id, move || {
                        let _ = cancel.Cancel();
                    }) {
                        return Ok(());
                    }
                    let connect = || -> windows::core::Result<()> {
                        let path = stage
                            .as_os_str()
                            .to_string_lossy()
                            .encode_utf16()
                            .chain(Some(0))
                            .collect::<Vec<_>>();
                        args.SetResultFilePath(PCWSTR(path.as_ptr()))?;
                        let mut token = 0;
                        operation.add_BytesReceivedChanged(
                            &BytesReceivedChangedEventHandler::create(Box::new(
                                move |operation, _| {
                                    if let Some(operation) = operation {
                                        let mut received = 0;
                                        let mut total = 0;
                                        operation.BytesReceived(&mut received)?;
                                        operation.TotalBytesToReceive(&mut total)?;
                                        downloads::progress(
                                            id,
                                            received.max(0) as u64,
                                            (total > 0).then_some(total as u64),
                                        );
                                    }
                                    Ok(())
                                },
                            )),
                            &mut token,
                        )?;
                        let settled_stage = stage.clone();
                        operation.add_StateChanged(
                            &StateChangedEventHandler::create(Box::new(move |operation, _| {
                                if let Some(operation) = operation {
                                    let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                                    operation.State(&mut state)?;
                                    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                                        downloads::settled(id, true, &settled_stage);
                                    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                                        downloads::settled(id, false, &settled_stage);
                                    }
                                }
                                Ok(())
                            })),
                            &mut token,
                        )?;
                        args.SetCancel(false)
                    };
                    if connect().is_err() {
                        downloads::finish(id, false);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    };
    install().map_err(|_| "无法安装 WebView2 下载隔离".into())
}
