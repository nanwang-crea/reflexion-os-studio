//! macOS Seatbelt provider：`sandbox-exec -p <profile>` 包装（deny-default 白名单）。
//! 语义参照 codex macOS 沙箱：读大体放开（保可用性）+ 敏感凭据路径拒读；
//! 写只放可写根；网络仅在审批放行（allow_network）时打开。
//! `sandbox-exec` 是 exec 语义（替换自身），包装后 pid 即 `sh` 的 pid，
//! 现有 `kill(-pgid)` 进程组树杀语义不变。

use std::path::{Path, PathBuf};

use super::{SandboxProvider, SandboxRequest};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Clone)]
pub(crate) struct SeatbeltSandbox {
    home: Option<PathBuf>,
    data_dir: PathBuf,
}

impl SeatbeltSandbox {
    /// Task 3 的 select() 接线前，macOS 非测试构建暂无消费者（测试构建有消费，故 not(test) 才放行）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // 与 runtime 存储同一规则：REFLEXION_DATA_DIR 优先，缺省 ~/.reflexion-os-studio。
        let data_dir = std::env::var_os("REFLEXION_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home.clone()
                    .unwrap_or_default()
                    .join(".reflexion-os-studio")
            });
        Self { home, data_dir }
    }

    /// 探测：二进制存在 + 最小 profile 干跑成功（未来 macOS 移除 sandbox-exec 时如实降级）。
    pub(crate) fn probe() -> bool {
        if !Path::new(SANDBOX_EXEC).exists() {
            return false;
        }
        std::process::Command::new(SANDBOX_EXEC)
            .args(["-p", "(version 1)(allow default)", "--", "/usr/bin/true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(crate) fn build_argv(&self, request: &SandboxRequest) -> Vec<String> {
        let profile = render_profile(request, self.home.as_deref(), &self.data_dir);
        vec![
            SANDBOX_EXEC.to_string(),
            "-p".to_string(),
            profile,
            "--".to_string(),
            "/bin/sh".to_string(),
            "-c".to_string(),
            request.command.clone(),
        ]
    }
}

impl SandboxProvider for SeatbeltSandbox {
    fn id(&self) -> &'static str {
        "seatbelt"
    }

    fn is_available(&self) -> bool {
        Self::probe()
    }

    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        Some(self.build_argv(request))
    }
}

fn denied_read_paths(home: Option<&Path>, data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data_dir.to_path_buf()];
    if let Some(home) = home {
        for tail in [".ssh", ".aws", ".gnupg"] {
            paths.push(home.join(tail));
        }
    }
    paths
}

/// 纯函数渲染，单测钉住核心结构；真机白名单微调以集成测试为准（禁软化核心语义）。
pub(crate) fn render_profile(
    request: &SandboxRequest,
    home: Option<&Path>,
    data_dir: &Path,
) -> String {
    let mut profile = String::from(
        "(version 1)\n\
         (deny default)\n\
         (allow process*)\n\
         (allow process-info*)\n\
         (allow signal (target same-sandbox))\n\
         (allow file-read*)\n",
    );
    let denied = denied_read_paths(home, data_dir);
    profile.push_str("(deny file-read*");
    for path in &denied {
        profile.push_str(&format!(" (subpath {})", sbpl_string(path)));
    }
    profile.push_str(")\n");
    for root in &request.writable_roots {
        profile.push_str(&format!(
            "(allow file-write* (subpath {}))\n",
            sbpl_string(root)
        ));
    }
    profile.push_str(
        "(allow file-write-data\n\
         \x20(literal \"/dev/null\") (literal \"/dev/dtracehelper\") (subpath \"/dev/tt\"))\n\
         (allow file-ioctl (literal \"/dev/null\") (subpath \"/dev/tt\"))\n\
         (allow sysctl-read)\n\
         (allow ipc-posix-shm)\n\
         (allow mach-lookup)\n\
         (allow iokit-open)\n",
    );
    if request.allow_network {
        profile.push_str("(allow network*)\n");
    }
    profile
}

/// SBPL 字符串字面量转义（路径可能含空格/引号）。
fn sbpl_string(path: &Path) -> String {
    let mut out = String::from('"');
    for ch in path.to_string_lossy().chars() {
        match ch {
            '"' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\{:03o}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(roots: &[&str], allow_network: bool) -> SandboxRequest {
        SandboxRequest {
            command: "echo hi".to_string(),
            cwd: PathBuf::from("/w"),
            timeout_ms: 1000,
            allow_network,
            writable_roots: roots.iter().map(PathBuf::from).collect(),
        }
    }

    #[test]
    fn profile_is_deny_default_with_scoped_allows() {
        let profile = render_profile(
            &request(&["/w", "/tmp/reflexion-sandbox"], false),
            Some(Path::new("/Users/tester")),
            Path::new("/Users/tester/.reflexion-os-studio"),
        );
        assert!(profile.starts_with("(version 1)\n(deny default)"));
        assert!(profile.contains("(allow file-write* (subpath \"/w\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/tmp/reflexion-sandbox\"))"));
        assert!(profile.contains("(subpath \"/Users/tester/.ssh\")"));
        assert!(profile.contains("(subpath \"/Users/tester/.reflexion-os-studio\")"));
        assert!(
            !profile.contains("(allow network"),
            "no network allowance without approval: {profile}"
        );
    }

    #[test]
    fn profile_opens_network_only_when_approved() {
        let profile = render_profile(&request(&["/w"], true), None, Path::new("/d"));
        assert!(profile.contains("(allow network*)"));
    }

    #[test]
    fn sbpl_string_escapes_quotes_backslashes_and_control() {
        let weird = PathBuf::from("/tmp/he said \"hi\"\\done\u{1}x");
        let rendered = sbpl_string(&weird);
        assert!(rendered.starts_with('"') && rendered.ends_with('"'));
        assert!(rendered.contains("\\\"hi\\\""));
        assert!(rendered.contains("\\\\done"));
        assert!(rendered.contains("\\001x"));
    }

    #[test]
    fn build_argv_is_sandbox_exec_prefix_plus_sh() {
        let sandbox = SeatbeltSandbox::from_env();
        let argv = sandbox.build_argv(&request(&["/w"], false));
        assert_eq!(argv[0], "/usr/bin/sandbox-exec");
        assert_eq!(argv[1], "-p");
        assert_eq!(argv[3], "--");
        assert_eq!(argv[4], "/bin/sh");
        assert_eq!(argv[5], "-c");
        assert_eq!(argv[6], "echo hi");
    }
}
