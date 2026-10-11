//! 默认 shell 选择（AGENTS §8：显式平台分支）。
//! 返回 argv（路径 + 独立参数数组），禁止拼接命令字符串。

use portable_pty::CommandBuilder;

#[cfg(unix)]
use super::unix_shell::{account_shell, select_shell, shell_argv};

/// macOS 对齐 Terminal 登录模式；Linux 对齐图形终端的交互模式。
#[cfg(unix)]
fn unix_shell_argv(shell: String) -> Vec<String> {
    shell_argv(shell, cfg!(target_os = "macos"))
}

#[cfg(unix)]
pub fn default_shell_argv() -> Vec<String> {
    unix_shell_argv(select_shell(std::env::var("SHELL").ok(), account_shell))
}

/// PTY 使用独立环境标识；继承用户 PATH，不清空或重写工具链变量。
pub fn shell_command(argv: &[String], cwd: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new(&argv[0]);
    command.args(&argv[1..]);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("TERM_PROGRAM", "ReflexionOS Studio");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("COLORTERM", "truecolor");
    command
}

/// 只检查存在性和目录类型，不以写权限限制用户终端。
/// portable-pty 在 Unix 对非法 cwd 会回退 HOME，必须提前拒绝，避免跑错目录。
pub fn validate_cwd(cwd: &str) -> Result<(), String> {
    if !std::path::Path::new(cwd).is_absolute() {
        return Err("terminal cwd must be an absolute directory path".to_string());
    }
    let metadata = std::fs::metadata(cwd)
        .map_err(|error| format!("terminal cwd inaccessible: {error}{}", access_hint()))?;
    if !metadata.is_dir() {
        return Err("terminal cwd is not a directory".to_string());
    }
    Ok(())
}

pub fn access_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "; 若访问被拒绝，请检查目录权限及系统设置 → 隐私与安全性 → 文件与文件夹中本应用的授权；此错误本身不能确定是 TCC"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "; 若访问被拒绝，请检查目录访问权限"
    }
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
    #[test]
    fn unix_default_shell_is_executable_absolute_path() {
        let argv = super::default_shell_argv();
        assert!(std::path::Path::new(&argv[0]).is_absolute());
        assert!(std::path::Path::new(&argv[0]).is_file());
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

#[cfg(test)]
#[path = "shell_command_tests.rs"]
mod launch_tests;
