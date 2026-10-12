use super::Credential;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
const SERVICE: &str = "com.reflexionos.studio.browser.passwords";
const ACCOUNT: &str = "imported-v1";
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Entry {
    pub origin: String,
    pub username: String,
    pub password: String,
}
fn read() -> Result<Vec<Entry>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("导入密码存储超过大小限制".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "导入密码存储无法解析".into())
        }
        Err(error) if error.code() == -25300 => Ok(Vec::new()),
        Err(_) => Err("系统钥匙串未允许访问本应用密码存储".into()),
    }
}
pub fn merge(incoming: Vec<Entry>) -> Result<usize, String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    let count = incoming.len();
    let mut entries = read()?;
    for entry in incoming {
        if let Some(existing) = entries
            .iter_mut()
            .find(|old| old.origin == entry.origin && old.username == entry.username)
        {
            *existing = entry;
        } else {
            entries.push(entry);
        }
    }
    if entries.len() > 10000 {
        return Err("导入密码最多保存 10000 条".into());
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&entries).map_err(|_| "密码存储编码失败")?);
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("密码存储超过大小限制".into());
    }
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, &bytes)
        .map_err(|_| "密码未保存：系统钥匙串拒绝访问".to_string())?;
    Ok(count)
}
pub fn list() -> Result<Vec<Credential>, String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    // No usernames/passwords cross IPC. Multiple accounts use a neutral ordinal label.
    Ok(read()?
        .iter()
        .enumerate()
        .map(|(ordinal, entry)| Credential {
            id: entry_id(entry),
            origin: entry.origin.clone(),
            label: format!("账户 {}", ordinal + 1),
        })
        .collect())
}
pub fn get(id: usize) -> Result<Entry, String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    let mut entries = read()?;
    let matches = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| entry_id(e) == id)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("密码条目已变化或不存在".into());
    }
    Ok(entries.remove(matches[0]))
}
pub fn clear() -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("系统钥匙串未允许删除密码".into()),
    }
}

pub fn replace(id: usize, expected: &Entry, next: Option<Entry>) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    let mut entries = read()?;
    let id = entries
        .iter()
        .position(|e| entry_id(e) == id)
        .ok_or("密码条目已不存在")?;
    if !entries.get(id).is_some_and(|e| {
        e.origin == expected.origin
            && e.username == expected.username
            && e.password == expected.password
    }) {
        return Err("密码条目已变化，请刷新后重试".into());
    }
    if let Some(next) = next {
        entries[id] = next;
    } else {
        entries.remove(id);
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&entries).map_err(|_| "密码存储编码失败")?);
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("密码存储超过大小限制".into());
    }
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, &bytes)
        .map_err(|_| "系统钥匙串拒绝密码修改".to_string())
}

fn entry_id(entry: &Entry) -> usize {
    let mut digest = Sha256::new();
    digest.update(entry.origin.as_bytes());
    digest.update([0]);
    digest.update(entry.username.as_bytes());
    let hash = digest.finalize();
    (u64::from_le_bytes(hash[..8].try_into().unwrap()) & 0x000f_ffff_ffff_ffff) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_identifiers_survive_list_reordering_and_password_edits() {
        let mut entry = Entry {
            origin: "https://example.test".into(),
            username: "synthetic-user".into(),
            password: "synthetic-only".into(),
        };
        let id = entry_id(&entry);
        entry.password = "another-synthetic-value".into();
        assert_eq!(id, entry_id(&entry));
        entry.username = "other-synthetic-user".into();
        assert_ne!(id, entry_id(&entry));
        assert!(id < (1usize << 53));
    }
}
