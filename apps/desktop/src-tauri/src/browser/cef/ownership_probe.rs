//! Opt-in native regression. Only compiled with cef-acceptance; no model or private data.
use super::super::state::{Action, Snapshot};
use std::{sync::mpsc, time::Duration};
use tauri::Manager;

fn control(app: &tauri::AppHandle, action: Action) -> Result<Snapshot, String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    super::dispatch(move || {
        let _ = tx.send(super::super::window::control(&handle, action));
    })?;
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "native ownership probe timed out".to_string())?
}

pub fn start(app: &tauri::AppHandle) {
    if std::env::var("CEF_OWNERSHIP_PROBE").as_deref() != Ok("1") {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let result = (|| -> Result<(), String> {
            control(&app, Action::Attach)?;
            let url = std::env::var("CEF_OWNERSHIP_PROBE_URL").ok();
            for round in 0..30 {
                let snapshot = control(&app, Action::Newtab { url: url.clone() })?;
                let id = snapshot.active_tab_id.ok_or("probe page unavailable")?;
                for visible in [true, false, true] {
                    control(
                        &app,
                        Action::Layout {
                            x: 600.0,
                            y: 140.0,
                            width: 400.0,
                            height: 300.0,
                            visible,
                        },
                    )?;
                    std::thread::sleep(Duration::from_millis(100));
                }
                control(&app, Action::Reload)?;
                control(&app, Action::Closetab { tab_id: id })?;
                crate::logging::write(&format!("[ownership-probe] round {}/30", round + 1));
            }
            crate::logging::write("[ownership-probe] idle sampling window (15s)");
            std::thread::sleep(Duration::from_secs(15));
            Ok(())
        })();
        match result {
            Ok(()) => crate::logging::write("[ownership-probe] PASS; closing parent window"),
            Err(error) => crate::logging::write(&format!("[ownership-probe] FAIL: {error}")),
        }
        let handle = app.clone();
        let _ = super::dispatch(move || {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.close();
            }
        });
    });
}
