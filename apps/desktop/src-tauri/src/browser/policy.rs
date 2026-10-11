use url::Url;

pub fn web_url(input: &str) -> Result<Url, String> {
    if input.chars().any(|c| c.is_control()) {
        return Err("invalid web URL".into());
    }
    let trimmed = input.trim();
    if trimmed.is_empty()
        || trimmed.len() > 8192
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("invalid web URL".into());
    }
    let url = Url::parse(trimmed).map_err(|_| "invalid web URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("only HTTP / HTTPS URLs without credentials are allowed".into());
    }
    Ok(url)
}

pub fn guest_url(input: &str, dev_url: Option<&Url>) -> Result<Url, String> {
    let url = web_url(input)?;
    if matches!(
        url.host_str(),
        Some("tauri.localhost" | "asset.localhost" | "ipc.localhost")
    ) || dev_url.is_some_and(|dev| {
        dev.origin() == url.origin()
            || (loopback(dev)
                && loopback(&url)
                && dev.port_or_known_default() == url.port_or_known_default())
    }) {
        return Err("application origins cannot be browsed".into());
    }
    Ok(url)
}

pub fn dev_url(app: &tauri::AppHandle) -> Option<&Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    }
}
fn loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Never log paths, query tokens, fragments, userinfo or native error details.
pub fn audit(action: &str, url: Option<&str>, result: &str) {
    let origin = audit_origin(url);
    crate::logging::write(&format!(
        "[browser] action={action} origin={origin} result={result}"
    ));
}

fn audit_origin(raw: Option<&str>) -> String {
    raw.and_then(|raw| web_url(raw).ok())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|| "redacted".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_never_keeps_private_url_parts() {
        assert_eq!(
            audit_origin(Some("https://example.com/private?token=sample#fragment")),
            "https://example.com"
        );
        assert_eq!(
            audit_origin(Some("https://user:sample@example.com/private")),
            "redacted"
        );
        assert_eq!(audit_origin(Some("file:///tmp/private")), "redacted");
    }
    #[test]
    fn accepts_web_and_local_targets_only() {
        for url in [
            "https://example.com",
            "http://example.com",
            "http://localhost:3000",
            "http://[::1]:3000",
            "http://192.168.1.2",
        ] {
            assert!(guest_url(url, None).is_ok());
        }
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "data:text/html,x",
            "blob:https://example.com/id",
            "tauri://localhost",
            "https://user:password@example.com",
            "http://ipc.localhost",
            "http://asset.localhost",
            "http://tauri.localhost",
            "http://",
            "https://example.com/\n",
        ] {
            assert!(guest_url(url, None).is_err(), "{url}");
        }
        let dev = Url::parse("http://localhost:5173").unwrap();
        assert!(guest_url("http://localhost:5173/index.html?x=1", Some(&dev)).is_err());
        assert!(guest_url("http://localhost:3000", Some(&dev)).is_ok());
        assert!(guest_url("http://127.0.0.1:5173", Some(&dev)).is_err());
        assert!(guest_url("http://[::1]:5173", Some(&dev)).is_err());
    }
}
