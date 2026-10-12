use serde::{Deserialize, Serialize};

#[derive(Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiteRule {
    pub origin: String,
    pub permission: String,
    pub policy: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub storage_mode: String,
    pub ask_download_location: bool,
    pub download_directory: Option<String>,
    pub site_rules: Vec<SiteRule>,
    pub contact_autofill: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            storage_mode: "temporary".into(),
            ask_download_location: true,
            download_directory: None,
            site_rules: Vec::new(),
            contact_autofill: false,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.storage_mode.as_str(), "temporary" | "persistent")
            || self.site_rules.len() > 500
        {
            return Err("invalid browser preferences".into());
        }
        for rule in &self.site_rules {
            let url = super::policy::web_url(&rule.origin)?;
            if url.origin().ascii_serialization() != rule.origin
                || !matches!(
                    rule.permission.as_str(),
                    "camera"
                        | "microphone"
                        | "geolocation"
                        | "notifications"
                        | "clipboard"
                        | "upload"
                )
                || !matches!(rule.policy.as_str(), "deny" | "ask")
            {
                return Err("invalid website permission rule".into());
            }
        }
        if let Some(path) = &self.download_directory {
            super::downloads::policy::directory(path)?;
        }
        Ok(())
    }
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    pub fn asks(&self, origin: &str, permission: &str) -> bool {
        self.site_rules
            .iter()
            .rev()
            .find(|r| r.origin == origin && r.permission == permission)
            .is_some_and(|r| r.policy == "ask")
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    pub id: String,
    pub label: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub address: String,
}
impl Contact {
    #[cfg(any(
        test,
        all(feature = "browser-spike", target_os = "macos"),
        target_os = "windows",
        target_os = "linux"
    ))]
    pub fn fill_values(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name, "email": self.email,
            "phone": self.phone, "address": self.address,
        })
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.id.len() > 200
            || self.label.len() > 400
            || self.name.len() > 800
            || self.email.len() > 1016
            || self.phone.len() > 400
            || self.address.len() > 4000
        {
            return Err("联系信息过长".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn webpage_fill_receives_fields_without_local_record_identity() {
        let contact = Contact {
            id: "synthetic-record-id".into(),
            label: "Synthetic home label".into(),
            name: "Synthetic Person".into(),
            email: "example@example.test".into(),
            phone: "synthetic phone".into(),
            address: "synthetic address".into(),
        };
        let fields = contact.fill_values();
        assert_eq!(fields.as_object().unwrap().len(), 4);
        assert_eq!(fields["name"], contact.name);
        assert_eq!(fields["email"], contact.email);
        assert_eq!(fields["phone"], contact.phone);
        assert_eq!(fields["address"], contact.address);
        assert!(fields.get("id").is_none());
        assert!(fields.get("label").is_none());
    }

    #[test]
    fn configure_action_uses_flat_typed_preferences_and_rejects_unknown_fields() {
        let mut value = serde_json::to_value(Preferences::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("kind".into(), "configure".into());
        assert!(serde_json::from_value::<crate::browser::state::Action>(value.clone()).is_ok());
        value
            .as_object_mut()
            .unwrap()
            .insert("secret".into(), "synthetic".into());
        assert!(serde_json::from_value::<crate::browser::state::Action>(value).is_err());
    }
    #[test]
    fn site_rules_reject_paths_and_cannot_grant_permanent_permission() {
        let mut preferences = Preferences::default();
        preferences.site_rules = vec![SiteRule {
            origin: "https://example.test/path".into(),
            permission: "camera".into(),
            policy: "ask".into(),
        }];
        assert!(preferences.validate().is_err());
        preferences.site_rules[0].origin = "https://example.test".into();
        preferences.site_rules[0].policy = "allow".into();
        assert!(preferences.validate().is_err());
        preferences.site_rules[0].policy = "ask".into();
        assert!(preferences.validate().is_ok());
    }
}
