use super::state::{Snapshot, Tab};

pub const MAX_TABS: usize = 24;

impl Snapshot {
    pub fn add_tab(&mut self, url: Option<String>) -> Result<u32, String> {
        if self.tabs.len() >= MAX_TABS {
            return Err("最多打开 24 个标签，请先关闭一个标签".into());
        }
        let id = self.next_tab_id;
        self.next_tab_id = id.checked_add(1).ok_or("标签编号已耗尽")?;
        self.tabs.push(Tab {
            id,
            title: "新标签页".into(),
            status: "idle".into(),
            progress: 0.0,
            url,
            can_go_back: false,
            can_go_forward: false,
            notice: None,
        });
        self.active_tab_id = Some(id);
        self.project_active();
        Ok(id)
    }

    pub fn select_tab(&mut self, id: u32) -> Result<(), String> {
        if !self.tabs.iter().any(|tab| tab.id == id) {
            return Err("标签已关闭".into());
        }
        self.active_tab_id = Some(id);
        self.project_active();
        Ok(())
    }

    pub fn close_tab(&mut self, id: u32) -> Result<(), String> {
        let position = self
            .tabs
            .iter()
            .position(|tab| tab.id == id)
            .ok_or("标签已关闭")?;
        self.tabs.remove(position);
        if self.active_tab_id == Some(id) {
            self.active_tab_id = self
                .tabs
                .get(position.min(self.tabs.len().saturating_sub(1)))
                .map(|tab| tab.id);
        }
        self.project_active();
        Ok(())
    }

    pub fn project_active(&mut self) {
        let active = self
            .tabs
            .iter()
            .find(|tab| Some(tab.id) == self.active_tab_id);
        self.url = active.and_then(|tab| tab.url.clone());
        self.progress = active.map_or(0.0, |tab| tab.progress);
        self.status = active.map(|tab| tab.status.clone()).unwrap_or_else(|| {
            if self.available {
                "idle"
            } else {
                "unavailable"
            }
            .into()
        });
        self.notice = active.and_then(|tab| tab.notice.clone());
        self.can_go_back = active.is_some_and(|tab| tab.can_go_back);
        self.can_go_forward = active.is_some_and(|tab| tab.can_go_forward);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::state::BrowserState;
    #[test]
    fn tabs_preserve_background_state_and_select_neighbor_on_close() {
        let mut state = BrowserState::default().snapshot.into_inner().unwrap();
        state.available = true;
        let first = state
            .add_tab(Some("https://example.com/one".into()))
            .unwrap();
        let second = state
            .add_tab(Some("https://example.com/two".into()))
            .unwrap();
        state.tabs[0].title = "First page".into();
        state.tabs[0].can_go_back = true;
        state.select_tab(first).unwrap();
        assert!(state.can_go_back);
        assert_eq!(
            state.tabs[1].url.as_deref(),
            Some("https://example.com/two")
        );
        state.close_tab(first).unwrap();
        assert_eq!(state.active_tab_id, Some(second));
        assert!(!state.can_go_back);
        state.close_tab(second).unwrap();
        assert_eq!(state.active_tab_id, None);
        assert!(state.url.is_none());
        assert!(state.select_tab(first).is_err());
    }
    #[test]
    fn bounded_tabs_never_reuse_closed_ids() {
        let mut state = BrowserState::default().snapshot.into_inner().unwrap();
        for _ in 0..MAX_TABS {
            state.add_tab(None).unwrap();
        }
        assert!(state.add_tab(None).is_err());
        state.close_tab(1).unwrap();
        assert_eq!(state.add_tab(None).unwrap(), 25);
    }
}
