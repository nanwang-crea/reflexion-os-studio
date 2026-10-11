//! 用隔离的 HOME/profile 验证真实 PTY，不读取用户配置或输出环境机密。
use super::*;

#[test]
fn invalid_cwd_is_rejected_instead_of_falling_back_to_home() {
    assert!(validate_cwd("relative").is_err());
    let root = std::env::temp_dir().join(format!("reflexion-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    assert!(validate_cwd(root.to_str().unwrap()).is_ok());
    let file = root.join("file");
    std::fs::write(&file, "fixture").unwrap();
    assert!(validate_cwd(file.to_str().unwrap())
        .unwrap_err()
        .contains("not a directory"));
    assert!(validate_cwd(root.join("missing").to_str().unwrap()).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn terminal_environment_identifies_the_app() {
    let command = shell_command(
        &default_shell_argv(),
        std::env::temp_dir().to_str().unwrap(),
    );
    assert_eq!(command.get_env("TERM").unwrap(), "xterm-256color");
    assert_eq!(
        command.get_env("TERM_PROGRAM").unwrap(),
        "ReflexionOS Studio"
    );
    assert_eq!(command.get_env("COLORTERM").unwrap(), "truecolor");
}

#[cfg(unix)]
#[test]
fn real_pty_matches_platform_shell_and_linux_rc_without_profile_sourcing() {
    use portable_pty::{native_pty_system, PtySize};
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    let modes = if cfg!(target_os = "macos") {
        vec![true, false]
    } else {
        vec![false]
    };
    for login in modes {
        for shell in ["/bin/zsh", "/bin/bash"] {
            if !std::path::Path::new(shell).is_file() {
                continue;
            }
            let name = std::path::Path::new(shell)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap();
            let root = std::env::temp_dir().join(format!(
                "reflexion-login-{}-{name}-{login}",
                std::process::id()
            ));
            std::fs::create_dir_all(root.join("tools")).unwrap();
            for tool in ["cargo", "pnpm"] {
                let file = root.join("tools").join(tool);
                std::fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
                std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let profile = "export RX_LOGIN=loaded\nexport PATH=\"$HOME/tools:/usr/bin:/bin\"\n";
            let rc = "export RX_INTERACTIVE=loaded\nexport PATH=\"$HOME/tools:/usr/bin:/bin\"\nalias rx_fixture='true'\nPS1=''\n";
            std::fs::write(root.join(".zprofile"), profile).unwrap();
            std::fs::write(root.join(".zshrc"), rc).unwrap();
            std::fs::write(
                root.join(".bash_profile"),
                if login {
                    format!("{profile}. \"$HOME/.bashrc\"\n")
                } else {
                    profile.to_string()
                },
            )
            .unwrap();
            std::fs::write(root.join(".bashrc"), rc).unwrap();
            let probe = "type rx_fixture >/dev/null 2>&1 && printf 'RX_ENV:%s:%s:%s:%s:%s\\n' \"$RX_LOGIN\" \"$RX_INTERACTIVE\" \"$(command -v cargo)\" \"$(command -v pnpm)\" \"$PWD\"";
            let external = std::process::Command::new(shell)
                .args(if login {
                    vec!["-l", "-i", "-c", probe]
                } else {
                    vec!["-i", "-c", probe]
                })
                .env("HOME", &root)
                .env("ZDOTDIR", &root)
                .env_remove("BASH_ENV")
                .env_remove("RX_LOGIN")
                .env_remove("RX_INTERACTIVE")
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(external.status.success());
            let expected = String::from_utf8(external.stdout).unwrap();
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut command = shell_command(
                &crate::terminal::unix_shell::shell_argv(shell.into(), login),
                root.to_str().unwrap(),
            );
            command.env("HOME", &root);
            command.env("ZDOTDIR", &root);
            command.env_remove("BASH_ENV");
            command.env_remove("RX_LOGIN");
            command.env_remove("RX_INTERACTIVE");
            let mut child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let mut killer = child.clone_killer();
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let (tx, rx) = mpsc::channel();
            let reading = std::thread::spawn(move || {
                let mut output = Vec::new();
                let mut buffer = [0; 4096];
                // PTY EOF may be reported as EIO on Unix.
                while let Ok(count) = reader.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    output.extend_from_slice(&buffer[..count]);
                }
                let _ = tx.send(String::from_utf8_lossy(&output).into_owned());
            });
            write!(writer, "{probe}\nexit\n").unwrap();
            let received = rx.recv_timeout(Duration::from_secs(10));
            if received.is_err() {
                let _ = killer.kill();
            }
            let _ = child.wait();
            reading.join().unwrap();
            let output = received.expect("PTY profile probe timed out");
            assert!(
                expected.contains(&format!(
                    "RX_ENV:{}:loaded:",
                    if login { "loaded" } else { "" }
                )),
                "external fixture profiles not loaded"
            );
            assert!(
                output.replace('\r', "").contains(expected.trim()),
                "PTY differs from external login shell: {output}"
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
