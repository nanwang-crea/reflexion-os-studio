/** Attachment responses may follow redirects before WKDownload exists. */
pub fn same_origin(initial: Option<&str>, response: Option<&str>) -> bool {
    initial.zip(response).is_some_and(|(initial, response)| {
        crate::browser::policy::web_url(response)
            .is_ok_and(|url| url.origin().ascii_serialization() == initial)
    })
}
#[cfg(test)]
mod tests {
    #[test]
    fn attachment_after_navigation_redirect_keeps_initiating_origin() {
        assert!(super::same_origin(
            Some("https://example.com"),
            Some("https://example.com/attachment")
        ));
        assert!(!super::same_origin(
            Some("https://example.com"),
            Some("https://other.com/attachment")
        ));
        assert!(!super::same_origin(
            Some("https://example.com"),
            Some("http://example.com/attachment")
        ));
        assert!(!super::same_origin(
            Some("https://example.com"),
            Some("https://example.com:8443/attachment")
        ));
        assert!(!super::same_origin(
            None,
            Some("https://example.com/attachment")
        ));
        assert!(!super::same_origin(
            Some("https://example.com"),
            Some("file:///tmp/file")
        ));
    }
}
