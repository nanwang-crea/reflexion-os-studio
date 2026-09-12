//! Windows 受限令牌：剥离全部特权（DISABLE_MAX_PRIVILEGE）+ 禁用 Administrators SID
//! + 低完整性级别（LOW, S-1-16-4096）。语义参照 codex unelevated 档。
//! 令牌进程内缓存：工厂探测时创建，之后所有沙箱执行复用同一句柄。

use std::sync::OnceLock;

use windows::core::{w, Result};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HLOCAL, HANDLE};
use windows::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, SetTokenInformation, DISABLE_MAX_PRIVILEGE,
    PSID, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel, WinBuiltinAdministratorsSid,
};
use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Safe wrapper around raw HANDLE for Send + Sync in static context.
struct SafeHandle(HANDLE);
unsafe impl Send for SafeHandle {}
unsafe impl Sync for SafeHandle {}

static RESTRICTED_TOKEN: OnceLock<Option<SafeHandle>> = OnceLock::new();

/// 工厂探测：成功创建受限令牌即视为可用；结果缓存，执行复用同一令牌。
pub(crate) fn probe() -> bool {
    restricted_token().is_some()
}

/// 受限令牌句柄（缓存）。None = 创建失败（此时 exec_direct 必须报错而非回退）。
pub(crate) fn restricted_token() -> Option<HANDLE> {
    RESTRICTED_TOKEN
        .get_or_init(|| create_restricted_token().ok().map(SafeHandle))
        .as_ref()
        .map(|h| h.0)
}

fn create_restricted_token() -> Result<HANDLE> {
    unsafe {
        let mut base = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY,
            &mut base,
        )?;

        // 禁用 Administrators SID（SECURITY_MAX_SID_SIZE = 68）。
        let mut admin_sid_buf = [0u8; 68];
        let mut sid_size = admin_sid_buf.len() as u32;
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            None,
            Some(PSID(admin_sid_buf.as_mut_ptr() as *mut core::ffi::c_void)),
            &mut sid_size,
        )?;
        let admin = SID_AND_ATTRIBUTES {
            Sid: PSID(admin_sid_buf.as_ptr() as *mut core::ffi::c_void),
            Attributes: 0,
        };

        // DISABLE_MAX_PRIVILEGE：剥离全部特权。
        let mut restricted = HANDLE::default();
        CreateRestrictedToken(
            base,
            DISABLE_MAX_PRIVILEGE,
            Some(&[admin]),
            None,
            None,
            &mut restricted,
        )?;

        CloseHandle(base)?;

        set_low_integrity(restricted)?;
        Ok(restricted)
    }
}

fn set_low_integrity(token: HANDLE) -> Result<()> {
    unsafe {
        let mut sid = PSID(std::ptr::null_mut());
        ConvertStringSidToSidW(w!("S-1-16-4096"), &mut sid)?;
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            },
        };
        let result = SetTokenInformation(
            token,
            TokenIntegrityLevel,
            &label as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
        );
        LocalFree(Some(HLOCAL(sid.0 as *mut core::ffi::c_void)));
        result
    }
}
