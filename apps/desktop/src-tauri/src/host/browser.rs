//! Private Runtime→Host requests are consumed here, never forwarded to webviews.
use crate::supervisor::SupervisorState;
use tauri::Manager;

pub fn configure_runtime_engine(command: &mut std::process::Command) {
    // Select by build capability, not readiness: failed CEF initialization must
    // report an unavailable host instead of launching standalone Chromium.
    if cfg!(all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    )) {
        command.env("REFLEXION_BROWSER_ENGINE", "cef");
    } else {
        command.env_remove("REFLEXION_BROWSER_ENGINE");
    }
}

pub fn control_changed(app: &tauri::AppHandle, lease: &str, paused: bool) {
    let state = app.state::<Arc<SupervisorState>>();
    let message = json!({"jsonrpc":"2.0","method":"host.browser.control","params":{"lease":lease,"paused":paused}});
    if let Ok(mut guard) = state.runtime.lock() {
        if let Some(process) = guard.as_mut() {
            let _ = writeln!(process.stdin, "{message}");
        }
    };
}
use serde_json::{json, Value};
use std::{io::Write, sync::Arc};

pub fn dispatch(app: &tauri::AppHandle, state: &Arc<SupervisorState>, message: &Value) -> bool {
    if message.get("method").and_then(Value::as_str) != Some("host.browser") {
        return false;
    }
    let Some(id) = message
        .get("id")
        .cloned()
        .filter(|id| id.as_str().is_some_and(|s| s.starts_with("host-browser:")))
    else {
        return true;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let handle = app.clone();
    let state = state.clone();
    let _ = crate::browser::commands::dispatch(app, move || {
        #[cfg(all(
            feature = "cef-browser",
            any(target_os = "macos", target_os = "windows")
        ))]
        let result = crate::browser::cef::bridge::execute(&handle, params);
        #[cfg(not(all(
            feature = "cef-browser",
            any(target_os = "macos", target_os = "windows")
        )))]
        let result: Result<Value, String> = {
            let _ = (handle, params);
            Err("browser_unavailable".into())
        };
        let response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error}}),
        };
        if let Ok(mut guard) = state.runtime.lock() {
            if let Some(process) = guard.as_mut() {
                let _ = writeln!(process.stdin, "{response}");
            }
        }
    });
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_engine_is_pinned_by_build_even_before_cef_is_ready() {
        let mut command = std::process::Command::new("unused");
        command.env("REFLEXION_BROWSER_ENGINE", "standalone");
        super::configure_runtime_engine(&mut command);
        let engine = command
            .get_envs()
            .find(|(key, _)| *key == "REFLEXION_BROWSER_ENGINE")
            .map(|(_, value)| value);
        let expected = if cfg!(all(
            feature = "cef-browser",
            any(target_os = "macos", target_os = "windows")
        )) {
            Some(std::ffi::OsStr::new("cef"))
        } else {
            None
        };
        assert_eq!(engine, Some(expected));
    }
}
