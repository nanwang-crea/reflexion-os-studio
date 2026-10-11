//! Unix 用户 shell 解析：只读取账户 API 的 shell 字段，不直接读取账户文件。
use std::ffi::{CStr, CString};
use std::path::Path;

pub(super) fn select_shell(
    shell_env: Option<String>,
    account_shell: impl FnOnce() -> Option<String>,
) -> String {
    shell_env
        .filter(|shell| executable_shell(shell))
        .or_else(|| account_shell().filter(|shell| executable_shell(shell)))
        .unwrap_or_else(|| "/bin/sh".to_string())
}

fn executable_shell(shell: &str) -> bool {
    let path = Path::new(shell);
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    let Ok(path) = CString::new(shell) else {
        return false;
    };
    // mode 位不能表达 ACL 等实际执行权限；让 OS 按当前身份检查。
    unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
}

pub(super) fn account_shell() -> Option<String> {
    let hint = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let mut size = if hint > 0 { hint as usize } else { 16_384 };
    while size <= 1_048_576 {
        let mut buffer = vec![0u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            size *= 2;
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        // getpwuid_r 成功后 entry 指针指向仍存活的 buffer；只复制 shell 字段。
        let entry = unsafe { entry.assume_init() };
        if entry.pw_shell.is_null() {
            return None;
        }
        return unsafe { CStr::from_ptr(entry.pw_shell) }
            .to_str()
            .ok()
            .map(str::to_owned);
    }
    None
}

pub(super) fn shell_argv(shell: String, login: bool) -> Vec<String> {
    let name = Path::new(&shell).file_name().and_then(|name| name.to_str());
    let flags: &[&str] = match name {
        Some("zsh" | "bash" | "fish" | "ksh" | "ksh93") if login => &["-l", "-i"],
        Some("zsh" | "bash" | "fish" | "ksh" | "ksh93" | "sh" | "dash") => &["-i"],
        _ => &[],
    };
    let mut argv = vec![shell];
    argv.extend(flags.iter().map(|flag| (*flag).to_string()));
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_flags_preserve_linux_interactive_rc() {
        for shell in ["/bin/zsh", "/bin/bash", "/usr/bin/fish", "/bin/ksh"] {
            assert_eq!(shell_argv(shell.into(), true), vec![shell, "-l", "-i"]);
            assert_eq!(shell_argv(shell.into(), false), vec![shell, "-i"]);
        }
        assert_eq!(
            shell_argv("/bin/dash".into(), true),
            vec!["/bin/dash", "-i"]
        );
        assert_eq!(
            shell_argv("/custom/unknown".into(), false),
            vec!["/custom/unknown"]
        );
    }

    #[test]
    fn missing_environment_uses_account_api_or_executable_fallback() {
        let shell = select_shell(None, account_shell);
        assert!(executable_shell(&shell));
    }

    #[test]
    fn environment_then_account_then_sh_with_execute_validation() {
        use std::os::unix::fs::PermissionsExt;
        let executable = std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(
            select_shell(Some(executable.clone()), || panic!(
                "account lookup unnecessary"
            )),
            executable
        );
        for env in [
            None,
            Some("".into()),
            Some("relative/zsh".into()),
            Some("/nonexistent/zsh".into()),
        ] {
            assert_eq!(select_shell(env, || Some(executable.clone())), executable);
        }
        let file = std::env::temp_dir().join(format!("reflexion-nonexec-{}", std::process::id()));
        std::fs::write(&file, "fixture").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            select_shell(Some(file.to_str().unwrap().into()), || Some(
                executable.clone()
            )),
            executable
        );
        assert_eq!(select_shell(None, || None), "/bin/sh");
        assert_eq!(
            select_shell(None, || Some(file.to_str().unwrap().into())),
            "/bin/sh"
        );
        std::fs::remove_file(file).unwrap();
    }
}
