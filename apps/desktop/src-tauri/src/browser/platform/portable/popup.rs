use super::Engine;
use crate::browser::state;
use tauri::AppHandle;

pub(crate) fn open<T>(
    app: &AppHandle,
    url: &str,
    create: impl FnOnce(u32) -> Result<(Box<dyn Engine>, T), String>,
) -> Result<T, String> {
    if !super::super::available() || !super::navigation_allowed(app, url) || super::clearing() {
        return Err("浏览器未启用或新窗口请求不允许".into());
    }
    let previous = state::snapshot(app).active_tab_id;
    let mut result = Err("标签创建失败".into());
    state::update(app, |snapshot| result = snapshot.add_tab(None));
    let id = result?;
    if let Err(error) = super::registry::select(app) {
        rollback(app, id, previous);
        return Err(error);
    }
    match create(id) {
        Ok((engine, handle)) => {
            if let Err(error) = super::registry::adopt(app, id, engine) {
                rollback(app, id, previous);
                return Err(error);
            }
            Ok(handle)
        }
        Err(error) => {
            rollback(app, id, previous);
            Err(error)
        }
    }
}
fn rollback(app: &AppHandle, id: u32, previous: Option<u32>) {
    super::registry::close_tab(id);
    state::update(app, |snapshot| {
        let selected = snapshot.active_tab_id == Some(id);
        let _ = snapshot.close_tab(id);
        if selected {
            if let Some(previous) = previous {
                let _ = snapshot.select_tab(previous);
            }
        }
    });
    let _ = super::registry::select(app);
}
