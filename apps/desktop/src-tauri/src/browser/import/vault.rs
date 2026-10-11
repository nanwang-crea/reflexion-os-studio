use super::Credential;
use serde::{Deserialize, Serialize};
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
        .map(|(id, entry)| Credential {
            id,
            origin: entry.origin.clone(),
            label: format!("账户 {}", id + 1),
        })
        .collect())
}
pub fn get(id: usize) -> Result<Entry, String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    let mut entries = read()?;
    if id >= entries.len() {
        return Err("密码条目已不存在".into());
    }
    Ok(entries.remove(id))
}
pub fn clear() -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "密码存储繁忙")?;
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("系统钥匙串未允许删除密码".into()),
    }
}
