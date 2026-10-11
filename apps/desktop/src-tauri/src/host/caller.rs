use tauri::{AppHandle, Webview};
use url::Url;

pub fn trusted(webview: &Webview, app: &AppHandle, labels: &[&str]) -> Result<(), String> {
    let url = webview.url().map_err(|_| "caller URL unavailable")?;
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    if trusted_source(webview.label(), &url, labels, dev) {
        Ok(())
    } else {
        Err("untrusted command caller or origin".into())
    }
}

pub(crate) fn trusted_source(label: &str, url: &Url, labels: &[&str], dev: Option<&Url>) -> bool {
    if !labels.contains(&label) || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let packaged = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    packaged || dev.is_some_and(|dev| dev.origin() == url.origin())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_both_trusted_label_and_origin() {
        let app = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(trusted_source("main", &app, &["main"], None));
        assert!(!trusted_source("browser-toolbar", &app, &["main"], None));
        assert!(!trusted_source("guest", &app, &["main"], None));
        for raw in [
            "https://example.com",
            "http://tauri.localhost:9000",
            "https://user@tauri.localhost",
            "http://localhost:5173",
        ] {
            assert!(!trusted_source(
                "main",
                &Url::parse(raw).unwrap(),
                &["main"],
                None
            ));
        }
        let dev = Url::parse("http://localhost:5173").unwrap();
        assert!(trusted_source("main", &dev, &["main"], Some(&dev)));
        assert!(!trusted_source(
            "main",
            &Url::parse("http://localhost:5174").unwrap(),
            &["main"],
            Some(&dev)
        ));
    }
}
