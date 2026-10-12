use super::*;
use objc2::define_class;
use objc2::runtime::NSObject;
pub struct DownloadIvars {
    pub(super) app: AppHandle,
    pub(super) id: usize,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DownloadIvars]
    pub struct DownloadDelegate;
    unsafe impl NSObjectProtocol for DownloadDelegate {}
    unsafe impl WKDownloadDelegate for DownloadDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn destination(
            &self,
            download: &WKDownload,
            response: &NSURLResponse,
            suggested: &NSString,
            handler: &Block<dyn Fn(*mut NSURL)>,
        ) {
            let result = choose(&self.ivars().app, response, &suggested.to_string());
            match result {
                Ok((staging, target, origin)) => {
                    let pending = TRANSFERS.with(|r| {
                        r.borrow()
                            .get(&self.ivars().id)
                            .is_some_and(|t| t.record.status == "pending")
                    });
                    if !pending {
                        if let Some(parent) = staging.parent() {
                            let _ = std::fs::remove_dir(parent);
                        }
                        handler.call((std::ptr::null_mut(),));
                        unsafe {
                            download.cancel(None);
                        }
                        return;
                    }
                    let native =
                        NSURL::fileURLWithPath(&NSString::from_str(&staging.to_string_lossy()));
                    TRANSFERS.with(|r| {
                        if let Some(t) = r.borrow_mut().get_mut(&self.ivars().id) {
                            t.record.origin = origin;
                            t.record.filename = target
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned();
                            t.record.status = "active".into();
                            t.staging = Some(staging);
                            t.destination = Some(target);
                        }
                    });
                    handler.call((Retained::as_ptr(&native).cast_mut(),));
                    let _ = self.ivars().app.emit_to("main", "browser:downloads", ());
                }
                Err(error) => {
                    finish(self.ivars().id, "cancelled", Some(error));
                    handler.call((std::ptr::null_mut(),));
                    unsafe {
                        download.cancel(None);
                    }
                }
            }
        }
        #[unsafe(method(download:willPerformHTTPRedirection:newRequest:decisionHandler:))]
        fn redirect(
            &self,
            _download: &WKDownload,
            _response: &objc2_foundation::NSHTTPURLResponse,
            request: &objc2_foundation::NSURLRequest,
            handler: &Block<dyn Fn(objc2_web_kit::WKDownloadRedirectPolicy)>,
        ) {
            let origin = request
                .URL()
                .and_then(|u| u.absoluteString())
                .and_then(|u| {
                    crate::browser::policy::guest_url(
                        &u.to_string(),
                        crate::browser::policy::dev_url(&self.ivars().app),
                    )
                    .ok()
                })
                .map(|u| u.origin().ascii_serialization());
            let allowed = TRANSFERS.with(|r| {
                r.borrow()
                    .get(&self.ivars().id)
                    .is_some_and(|t| Some(&t.record.origin) == origin.as_ref())
            });
            handler.call((if allowed {
                objc2_web_kit::WKDownloadRedirectPolicy::Allow
            } else {
                objc2_web_kit::WKDownloadRedirectPolicy::Cancel
            },));
            if !allowed {
                finish(
                    self.ivars().id,
                    "failed",
                    Some("已拒绝跨来源下载重定向".into()),
                );
            }
        }
        #[unsafe(method(downloadDidFinish:))]
        fn completed(&self, _download: &WKDownload) {
            let paths = TRANSFERS.with(|r| {
                r.borrow()
                    .get(&self.ivars().id)
                    .and_then(|t| Some((t.staging.clone()?, t.destination.clone()?)))
            });
            let result = paths
                .ok_or("下载目标已失效".to_string())
                .and_then(|(stage, target)| {
                    policy::publish(&stage, &target)?;
                    Ok(target)
                });
            match result {
                Ok(path) => {
                    TRANSFERS.with(|r| {
                        if let Some(t) = r.borrow_mut().get_mut(&self.ivars().id) {
                            t.record.path = Some(path.to_string_lossy().into_owned());
                        }
                    });
                    finish(self.ivars().id, "completed", None);
                }
                Err(error) => finish(self.ivars().id, "failed", Some(error)),
            }
        }
        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn failed(&self, _download: &WKDownload, _error: &NSError, _resume: Option<&NSData>) {
            finish(
                self.ivars().id,
                "failed",
                Some("下载失败；可重新从网页下载".into()),
            );
        }
    }
);
