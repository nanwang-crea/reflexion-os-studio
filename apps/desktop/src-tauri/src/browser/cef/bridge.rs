use crate::browser::state;
use serde::Deserialize;
use serde_json::{json, Value};

// Mirrors contracts/browser/host.ts; this is a private stdio transport adapter.
#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Request {
    #[serde(rename = "open", rename_all = "camelCase")]
    Open {
        lease: String,
        session_id: String,
        origin: String,
    },
    #[serde(rename = "check")]
    Check { lease: String },
    #[serde(rename = "close")]
    Close { lease: String },
}
fn lease_valid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub fn execute(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    if !super::accepting() {
        return Err("browser_unavailable".into());
    }
    let request: Request = serde_json::from_value(params).map_err(|_| "browser_request_invalid")?;
    match request {
        Request::Open {
            lease,
            session_id,
            origin,
        } => {
            if !lease_valid(&lease) || session_id.is_empty() || session_id.len() > 256 {
                return Err("browser_request_invalid".into());
            }
            let target =
                crate::browser::policy::guest_url(&origin, crate::browser::policy::dev_url(app))
                    .map_err(|_| "browser_request_invalid")?;
            if target.origin().ascii_serialization() != origin {
                return Err("browser_request_invalid".into());
            }
            if super::registry::lease_tab(&lease).is_some() {
                return Err("browser_request_invalid".into());
            }
            let mut tab = Err("browser_capacity".to_string());
            state::update(app, |state| {
                tab = state.add_tab(None);
            });
            let id = tab?;
            state::update_tab(app, id, |tab| {
                tab.control = "agent".into();
                tab.title = "Agent 浏览器".into();
            });
            if let Err(error) = super::registry::attach(
                app,
                Some(super::registry::Lease {
                    id: lease.clone(),
                    origin,
                }),
            ) {
                state::update(app, |state| {
                    let _ = state.close_tab(id);
                });
                return Err(error);
            }
            Ok(
                json!({"endpoint":super::endpoint(),"marker":format!("about:blank#{lease}"),"tabId":id}),
            )
        }
        Request::Check { lease } => {
            if !lease_valid(&lease) {
                return Err("browser_request_invalid".into());
            }
            let (_, locked, ready) = super::registry::lease_tab(&lease).ok_or("browser_closed")?;
            if !ready {
                return Err("browser_unavailable".into());
            }
            if !locked {
                return Err("browser_user_control".into());
            }
            Ok(json!({"ok":true}))
        }
        Request::Close { lease } => {
            if !lease_valid(&lease) {
                return Err("browser_request_invalid".into());
            }
            if let Some((id, _, _)) = super::registry::lease_tab(&lease) {
                super::registry::close(id);
                state::update(app, |state| {
                    let _ = state.close_tab(id);
                });
                let _ = super::registry::refresh(app);
            }
            Ok(json!({"closed":true}))
        }
    }
}
