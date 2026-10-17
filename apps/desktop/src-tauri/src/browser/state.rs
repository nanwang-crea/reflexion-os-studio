use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: u32,
    pub title: String,
    pub control: String,
    pub status: String,
    pub progress: f64,
    pub url: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub notice: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tabs: Vec<Tab>,
    pub active_tab_id: Option<u32>,
    #[serde(skip)]
    pub next_tab_id: u32,
    pub available: bool,
    pub status: String,
    pub progress: f64,
    pub url: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub revision: u64,
    pub notice: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    Configure {
        #[serde(flatten)]
        preferences: super::preferences::Preferences,
    },
    Find {
        text: String,
        backwards: bool,
    },
    Zoom {
        factor: f64,
    },
    Print,
    Fillcontact {
        contact: super::preferences::Contact,
    },
    Configurekeychain {
        mock: bool,
    },
    Newtab {
        url: Option<String>,
    },
    Selecttab {
        #[serde(rename = "tabId")]
        tab_id: u32,
    },
    Closetab {
        #[serde(rename = "tabId")]
        tab_id: u32,
    },
    Attach,
    Takeover,
    Resume,
    Status,
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Stop,
    Close,
    Closeuser,
    Layout {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        visible: bool,
    },
}

pub struct BrowserState {
    pub snapshot: Mutex<Snapshot>,
    pub preferences: Mutex<super::preferences::Preferences>,
}
impl Default for BrowserState {
    fn default() -> Self {
        let available = super::platform::available();
        Self {
            preferences: Mutex::new(super::preferences::Preferences::default()),
            snapshot: Mutex::new(Snapshot {
                tabs: Vec::new(),
                active_tab_id: None,
                next_tab_id: 1,
                available,
                status: if available { "idle" } else { "unavailable" }.into(),
                url: None,
                progress: 0.0,
                can_go_back: false,
                can_go_forward: false,
                revision: 0,
                notice: if available {
                    None
                } else {
                    Some(super::platform::unavailable_notice().into())
                },
            }),
        }
    }
}

pub fn snapshot(app: &AppHandle) -> Snapshot {
    app.state::<BrowserState>()
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub fn update(app: &AppHandle, f: impl FnOnce(&mut Snapshot)) -> Snapshot {
    let state = app.state::<BrowserState>();
    let next = {
        let mut state = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut state);
        state.revision += 1;
        state.clone()
    };
    // Never broadcast a page URL to all windows or the Runtime.
    if let Some(toolbar) = app.get_webview_window("main") {
        let _ = toolbar.emit("browser:state", &next);
    }
    next
}

/// Ignore callbacks from disposed tabs; background events never replace the active projection.
#[cfg(any(
    all(feature = "browser-spike", target_os = "macos"),
    target_os = "windows",
    target_os = "linux"
))]
pub fn update_tab(app: &AppHandle, id: u32, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<BrowserState>();
    let next = {
        let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(tab) = snapshot.tabs.iter_mut().find(|tab| tab.id == id) else {
            return;
        };
        let previous = tab.clone();
        f(tab);
        if *tab == previous {
            return;
        }
        snapshot.project_active();
        snapshot.revision += 1;
        snapshot.clone()
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("browser:state", &next);
    }
}

pub fn preferences(app: &AppHandle) -> super::preferences::Preferences {
    app.state::<BrowserState>()
        .preferences
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
