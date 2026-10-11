use super::{
    platform,
    state::{self, Action, Snapshot},
};
use tauri::AppHandle;

pub fn control(app: &AppHandle, action: Action) -> Result<Snapshot, String> {
    match action {
        Action::Newtab { url } => {
            let mut result = Ok(0);
            state::update(app, |state| {
                result = state.add_tab(url);
            });
            result?;
            platform::attach(app)?;
        }
        Action::Selecttab { tab_id } => {
            let mut result = Ok(());
            state::update(app, |state| {
                result = state.select_tab(tab_id);
            });
            result?;
            platform::attach(app)?;
        }
        Action::Closetab { tab_id } => {
            let mut result = Ok(());
            state::update(app, |state| {
                result = state.close_tab(tab_id);
            });
            result?;
            platform::close_tab(tab_id);
            if state::snapshot(app).tabs.is_empty() {
                state::update(app, |state| {
                    let _ = state.add_tab(None);
                });
            }
            platform::attach(app)?;
        }
        Action::Attach if platform::available() => {
            if state::snapshot(app).tabs.is_empty() {
                state::update(app, |state| {
                    let _ = state.add_tab(None);
                });
            }
            platform::attach(app)?;
        }
        Action::Attach | Action::Status | Action::Layout { .. } if !platform::available() => {}
        Action::Close => {
            platform::dispose();
            super::policy::audit("close", None, "disposed");
            state::update(app, |state| {
                state.tabs.clear();
                state.active_tab_id = None;
                state.url = None;
                state.status = if state.available {
                    "idle"
                } else {
                    "unavailable"
                }
                .into();
                state.notice = None;
                state.can_go_back = false;
                state.can_go_forward = false;
            });
        }
        _ => platform::control(app, &action)?,
    }
    Ok(state::snapshot(app))
}
