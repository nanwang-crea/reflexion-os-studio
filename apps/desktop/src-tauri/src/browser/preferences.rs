use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub storage_mode: String,
    pub ask_download_location: bool,
    pub download_directory: Option<String>,
    pub contact_autofill: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            storage_mode: "temporary".into(),
            ask_download_location: true,
            download_directory: None,
            contact_autofill: false,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.storage_mode.as_str(), "temporary" | "persistent") {
            return Err("invalid browser preferences".into());
        }
        if let Some(path) = &self.download_directory {
            super::downloads::policy::directory(path)?;
        }
        Ok(())
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
}
