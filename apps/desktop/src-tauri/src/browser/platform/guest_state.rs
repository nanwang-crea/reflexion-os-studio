use crate::browser::state::Tab;

pub(super) fn loading(tab: &mut Tab, url: &str, finished: bool) {
    // about:blank is an engine-internal starting page, never a visited page.
    if crate::browser::policy::web_url(url).is_err() {
        if url == "about:blank" && tab.url.is_none() && finished {
            tab.status = "idle".into();
            tab.progress = 0.0;
            tab.notice = None;
        }
        return;
    }
    tab.url = Some(url.into());
    tab.status = if finished { "ready" } else { "loading" }.into();
    tab.progress = if finished { 0.0 } else { tab.progress.max(0.1) };
    tab.notice = None;
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty_internal_page_finishes_idle_without_a_spinner() {
        let mut snapshot = crate::browser::state::BrowserState::default()
            .snapshot
            .into_inner()
            .unwrap();
        snapshot.add_tab(None).unwrap();
        let tab = &mut snapshot.tabs[0];
        tab.status = "loading".into();
        super::loading(tab, "about:blank", true);
        assert_eq!(tab.status, "idle");
        assert_eq!(tab.progress, 0.0);
        assert!(tab.url.is_none());
    }
    #[test]
    fn blank_never_replaces_web_url_and_redirect_preserves_actual_protocol() {
        let mut snapshot = crate::browser::state::BrowserState::default()
            .snapshot
            .into_inner()
            .unwrap();
        snapshot
            .add_tab(Some("http://example.test/".into()))
            .unwrap();
        let tab = &mut snapshot.tabs[0];
        super::loading(tab, "about:blank", false);
        assert_eq!(tab.url.as_deref(), Some("http://example.test/"));
        super::loading(tab, "https://example.test/", true);
        assert_eq!(tab.status, "ready");
        assert_eq!(tab.url.as_deref(), Some("https://example.test/"));
    }
}
