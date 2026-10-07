//! 默认 shell 选择（AGENTS §8：显式平台分支）。
//! 返回 argv（路径 + 独立参数数组），禁止拼接命令字符串。

#[cfg(unix)]
use std::path::PathBuf;

/// 纯函数版回退逻辑：显式注入 env 值（Option），避免测试改动进程环境
/// （cargo 默认多线程，set_var 是进程级共享状态，会与并发测试竞态）。
/// 有效用户 shell 优先；不存在/为空/非普通文件回退 /bin/sh。
#[cfg(unix)]
fn shell_from_env(shell_env: Option<String>) -> Vec<String> {
    let user_shell = shell_env
        .filter(|value| !value.trim().is_empty() && PathBuf::from(value).is_file())
        .unwrap_or_else(|| "/bin/sh".to_string());
    vec![user_shell]
}

/// 读取 SHELL 环境变量的薄包装。
#[cfg(unix)]
pub fn default_shell_argv() -> Vec<String> {
    shell_from_env(std::env::var("SHELL").ok())
}

/// 查找文件即可，不运行 shell（避免窗口闪烁与用户 profile 阻塞协议线程）。
#[cfg(any(windows, test))]
fn windows_shell_in_path(path: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    let directories: Vec<_> = std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .collect();
    for name in ["pwsh.exe", "powershell.exe"] {
        for dir in &directories {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn default_shell_argv() -> Vec<String> {
    if let Some(shell) = std::env::var_os("PATH").and_then(|path| windows_shell_in_path(&path)) {
        return vec![shell.to_string_lossy().into_owned()];
    }
    // PATH 可以被用户精简，Windows PowerShell 仍可从系统目录找到。
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    vec![std::path::PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .to_string_lossy()
        .into_owned()]
}

#[cfg(test)]
mod path_tests {
    use super::windows_shell_in_path;

    #[test]
    fn windows_shell_lookup_prefers_pwsh_without_executing_files() {
        let root = std::env::temp_dir().join(format!("reflexion-shell-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("powershell.exe"), b"not executable").unwrap();
        assert_eq!(
            windows_shell_in_path(root.as_os_str()),
            Some(root.join("powershell.exe"))
        );
        std::fs::write(root.join("pwsh.exe"), b"not executable").unwrap();
        assert_eq!(
            windows_shell_in_path(root.as_os_str()),
            Some(root.join("pwsh.exe"))
        );
        assert_eq!(windows_shell_in_path(std::ffi::OsStr::new("")), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{default_shell_argv, shell_from_env};

    #[test]
    fn unix_shell_is_executable_absolute_path() {
        let argv = default_shell_argv();
        assert_eq!(argv.len(), 1);
        // SHELL 未设置/非法时也必须落在绝对路径（/bin/sh 兜底）。
        assert!(std::path::Path::new(&argv[0]).is_absolute());
    }

    #[test]
    fn unix_falls_back_to_bin_sh_when_shell_invalid() {
        // 纯函数注入 env 值，不改动进程环境（cargo 测试多线程，set_var 会有进程级竞态）。
        let fallback = vec!["/bin/sh".to_string()];
        assert_eq!(shell_from_env(None), fallback);
        assert_eq!(shell_from_env(Some(String::new())), fallback);
        assert_eq!(shell_from_env(Some("   ".to_string())), fallback);
        // 指向目录（非普通文件）与不存在路径同样回退。
        assert_eq!(shell_from_env(Some("/tmp".to_string())), fallback);
        assert_eq!(
            shell_from_env(Some("/nonexistent/shell-for-test-42".to_string())),
            fallback
        );
    }

    #[test]
    fn unix_prefers_valid_user_shell() {
        // current_exe 必然是存在普通文件，作为确定性的「有效 shell」输入。
        let shell = std::env::current_exe().unwrap().display().to_string();
        assert_eq!(shell_from_env(Some(shell.clone())), vec![shell]);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::default_shell_argv;

    #[test]
    fn windows_shell_argv_is_single_path() {
        assert_eq!(default_shell_argv().len(), 1);
    }
}
