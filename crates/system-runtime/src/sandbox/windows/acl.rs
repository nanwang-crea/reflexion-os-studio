//! Windows 文件写边界：对可写 root（workspace root、沙盒临时目录）打 LOW 强制完整性
//! 标签（SACL "S:(ML;;OICI;;;LW)"，OI/CI 继承）。低完整性子进程只能写 LOW 标签目录。
//! 标签持久化在目录 ACL 上（幂等重设）；已处理 root 缓存，避免每命令重复设 ACL。
//! 注意：不给整个用户 TEMP 打标签（副作用过大），沙盒临时目录是专用子目录（见 launch.rs）。

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetSecurityDescriptorSacl, ACL, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
};

static LABELED_ROOTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 确保 path 具备 LOW 完整性标签；失败即 Err（调用方 fail-closed，不允许半沙箱）。
pub(crate) fn ensure_low_label(path: &Path) -> Result<(), String> {
    let key = path.to_string_lossy().into_owned();
    let mut guard = LABELED_ROOTS
        .lock()
        .map_err(|_| "low label cache poisoned".to_string())?;
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(&key) {
        return Ok(());
    }
    apply_low_label(path)
        .map_err(|error| format!("low integrity label failed for {key}: {error}"))?;
    set.insert(key);
    Ok(())
}

fn apply_low_label(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let mut object: Vec<u16> = path.as_os_str().encode_wide().collect();
    object.push(0);
    unsafe { set_label(object).map_err(|error| error.to_string()) }
}

unsafe fn set_label(mut object: Vec<u16>) -> windows::core::Result<()> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
        w!("S:(ML;;OICI;;;LW)"),
        SDDL_REVISION_1,
        &mut sd,
        None,
    )?;
    let mut present = false.into();
    let mut defaulted = false.into();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted)?;
    let result = SetNamedSecurityInfoW(
        PCWSTR(object.as_mut_ptr()),
        SE_FILE_OBJECT,
        LABEL_SECURITY_INFORMATION,
        None,
        None,
        None,
        Some(sacl),
    )
    .ok();

    LocalFree(Some(HLOCAL(sd.0 as *mut core::ffi::c_void)));

    result
}
