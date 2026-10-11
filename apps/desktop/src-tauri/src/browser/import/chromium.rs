use super::{crypto, vault, Report, Request};
use crate::browser::platform;
use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use zeroize::{Zeroize, ZeroizeOnDrop};
static IMPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Cookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires: Option<f64>,
    pub same_site: String,
}
fn database(root: &Path, name: &Path) -> Result<Connection, String> {
    let path = root.join(name);
    let canonical = path
        .canonicalize()
        .map_err(|_| "来源数据库不存在，请检查浏览器配置")?;
    if !canonical.starts_with(root)
        || canonical.metadata().map_err(|_| "来源数据库不可用")?.len() > 256 * 1024 * 1024
    {
        return Err("来源数据库越界或超过大小限制".into());
    }
    let source = Connection::open_with_flags(
        canonical,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "来源数据库不可用，请先关闭来源浏览器")?;
    let mut snapshot = Connection::open_in_memory().map_err(|_| "无法创建导入快照")?;
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut snapshot)
            .map_err(|_| "来源数据库快照失败")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match backup.step(256).map_err(|_| "来源数据库快照失败")? {
                rusqlite::backup::StepResult::Done => break,
                _ if Instant::now() >= deadline => {
                    return Err("来源数据库被占用，请关闭浏览器后重试".into())
                }
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }
    Ok(snapshot)
}
fn profile(request: &Request) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("系统用户目录不可用")?;
    let base = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(match request.source.as_str() {
            "chrome" => PathBuf::from("Google").join("Chrome"),
            "edge" => PathBuf::from("Microsoft Edge"),
            _ => return Err("不支持的来源浏览器".into()),
        })
        .canonicalize()
        .map_err(|_| "未找到来源浏览器")?;
    let profile = base
        .join(&request.profile)
        .canonicalize()
        .map_err(|_| "未找到来源配置")?;
    if !profile.starts_with(base) {
        return Err("来源配置越界".into());
    }
    Ok(profile)
}
fn cookies(root: &Path, key: &[u8; 16], skipped: &mut usize) -> Result<Vec<Cookie>, String> {
    let relative = if root.join("Network").join("Cookies").exists() {
        PathBuf::from("Network").join("Cookies")
    } else {
        PathBuf::from("Cookies")
    };
    let db = database(root, &relative)?;
    let version: String = db
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
            row.get(0)
        })
        .map_err(|_| "Cookie 数据库版本不受支持")?;
    let version: i64 = version.parse().map_err(|_| "Cookie 数据库版本不受支持")?;
    // Partitioned cookies cannot be represented safely in WKHTTPCookieStore.
    let mut query = db.prepare("SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,top_frame_site_key FROM cookies LIMIT 10001")
        .map_err(|_| "Cookie 数据库结构不受支持")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, bool>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|_| "Cookie 读取失败")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间不可用")?
        .as_secs_f64();
    let mut cookies = Vec::new();
    for (index, row) in rows.enumerate() {
        if index >= 10000 {
            return Err("Cookie 超过 10000 条，请缩小迁移范围".into());
        }
        let (
            host,
            name,
            value,
            mut encrypted,
            path,
            expires,
            secure,
            http_only,
            same_site,
            partition,
        ) = row.map_err(|_| "Cookie 数据读取失败")?;
        let expires = (expires > 0).then_some(expires as f64 / 1_000_000.0 - 11_644_473_600.0);
        if !partition.is_empty() || expires.is_some_and(|expiry| expiry <= now) {
            *skipped += 1;
            continue;
        }
        let value = if encrypted.is_empty() {
            value
        } else {
            let decoded =
                crypto::decrypt(&encrypted, key, (version >= 24).then_some(host.as_str()))?;
            encrypted.zeroize();
            decoded.to_string()
        };
        cookies.push(Cookie {
            host,
            name,
            value,
            path,
            expires,
            secure,
            http_only,
            same_site: match same_site {
                0 => "None",
                1 => "Lax",
                2 => "Strict",
                _ => "",
            }
            .into(),
        });
    }
    Ok(cookies)
}
fn passwords(
    root: &Path,
    key: &[u8; 16],
    skipped: &mut usize,
) -> Result<Vec<vault::Entry>, String> {
    let db = database(root, Path::new("Login Data"))?;
    let mut query = db.prepare("SELECT origin_url,username_value,password_value FROM logins WHERE blacklisted_by_user = 0 LIMIT 10001")
        .map_err(|_| "密码数据库结构不受支持")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|_| "密码读取失败")?;
    let mut entries = Vec::new();
    for (index, row) in rows.enumerate() {
        if index >= 10000 {
            return Err("密码超过 10000 条".into());
        }
        let (origin, username, mut encrypted) = row.map_err(|_| "密码数据读取失败")?;
        let Ok(url) = url::Url::parse(&origin) else {
            *skipped += 1;
            continue;
        };
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || encrypted.is_empty()
        {
            *skipped += 1;
            continue;
        }
        let password = crypto::decrypt(&encrypted, key, None)?;
        encrypted.zeroize();
        entries.push(vault::Entry {
            origin: url.origin().ascii_serialization(),
            username,
            password: password.to_string(),
        });
    }
    Ok(entries)
}
pub fn import(app: &AppHandle, request: Request) -> Result<Report, String> {
    let _guard = IMPORT_LOCK.try_lock().map_err(|_| "已有导入正在进行")?;
    let expected_tab = crate::browser::state::snapshot(app)
        .active_tab_id
        .ok_or("请先打开浏览会话")?;
    let root = profile(&request)?;
    let key = crypto::key(&request.source)?;
    let mut skipped = 0;
    // Decode and validate both scopes before making any destination change.
    let cookies = if request.cookies {
        cookies(&root, &key, &mut skipped)?
    } else {
        Vec::new()
    };
    let passwords = if request.passwords {
        passwords(&root, &key, &mut skipped)?
    } else {
        Vec::new()
    };
    let password_count = if request.passwords {
        vault::merge(passwords)?
    } else {
        0
    };
    let cookie_count = match platform::install_cookies(app, cookies, expected_tab) {
        Ok(count) => count,
        Err(_) => return Ok(Report { passwords: password_count, skipped, notice: "Cookie 未完成导入，可能部分写入；密码保存数量见结果。浏览会话已关闭或 WebKit 未完成写入，请重新导入 Cookie".into(), ..Report::default() }),
    };
    Ok(Report { cookies: cookie_count, passwords: password_count, skipped, cancelled: false,
        notice: "迁移完成。已跳过过期/分区 Cookie 和非 HTTPS 密码；来源网站仍可能要求重新登录。Cookie 仅在本次浏览会话有效。".into() })
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
