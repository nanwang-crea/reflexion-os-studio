use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral;

// Complete even when a native callback returns early or setup fails.
pub(super) struct Completion(pub ICoreWebView2Deferral);
impl Drop for Completion {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Complete() };
    }
}
