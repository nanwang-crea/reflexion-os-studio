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
    let mut paths = vec![profile_path(data_dir)];
    if let Some(home) = home {
        for tail in [".ssh", ".aws", ".gnupg"] {
            paths.push(profile_path(&home.join(tail)));
        }
    }
    paths
}

/// 内核按解析后的真实 vnode 路径匹配，macOS `/var`、`/tmp` 是指向 `/private/*` 的符号链接：
/// 规则路径必须 canonicalize，否则 subpath 静默失配（真机实测：`/var/folders/...` 的
/// deny/allow 都命中不了 `/private/var/folders/...` 下的 vnode）。
/// 末段可能尚不存在（沙盒临时目录在 wrap 之后才创建），故取「最长现存祖先」解析后
/// 拼回剩余尾段。只规范化根自身，不放开洞：写越根内符号链接落在根外路径，
/// 仍被 deny default 拒。连 `/` 都解析失败的病态情况下回退原样。
fn profile_path(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(resolved) = std::fs::canonicalize(ancestor) {
            let tail = path.strip_prefix(ancestor).unwrap_or(path);
            return resolved.join(tail);
        }
    }
    path.to_path_buf()
}

/// 纯函数渲染，单测钉住核心结构；真机白名单微调以集成测试为准（禁软化核心语义）。
///
/// 白名单记录（round B 真机验收，每条对应实测依据）：
/// - `process*` / `process-info*` / `signal (target same-sandbox)`：exec 链与超时 kill 必需；
///   sandbox-exec exec 替换自身保持 pgid，`kill(-pgid)` 树杀语义不变（timeout_survives_wrapping）。
/// - `file-read*` + 定向 deny（data_dir、HOME 的 .ssh/.aws/.gnupg）：读大体放开保工具可用，
///   凭据路径拒读（sensitive_read_denied_sibling_read_allowed）。deny 侧同样必须
///   canonicalize（`profile_path`），否则 /var 系路径下假数据目录静默漏读——真机首跑即中招。
/// - `file-write*` per writable_root（workspace + 沙盒临时目录）：写边界主语义
///   （write_escape_denied / in_boundary_writes_allowed）；根路径 canonicalize 修复
///   /var→/private/var 首跑失配。
/// - `file-write-data /dev/null /dev/dtracehelper /dev/tt*`、`file-ioctl /dev/null /dev/tt*`：
///   sh/git 等写 /dev/null、探测 tty（subpath "/dev/tt" 为字符串前缀匹配，覆盖
///   /dev/tty 与 /dev/ttysXXX，Chrome seatbelt 同款写法）。
/// - `sysctl-read` / `ipc-posix-shm` / `mach-lookup` / `iokit-open`：git --version、python3、
///   ls 冒烟通过所需（common_tools_no_collateral）；mach-lookup 不细分服务列表是
///   已知宽松点，收紧属 Phase 6 硬化。
/// - `network*`：仅 allow_network（用户审批 sandbox_network 后）渲染；未授权时
///   connect 得到 EPERM 而非 ECONNREFUSED（network_denied_without_approval）。
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
            sbpl_string(&profile_path(root))
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
        // 根路径用「不存在的 /w 之下」保证 profile_path 跨平台渲染为原样（仅 / 参与解析）。
        let profile = render_profile(
            &request(&["/w", "/w/reflexion-sandbox"], false),
            Some(Path::new("/Users/tester")),
            Path::new("/Users/tester/.reflexion-os-studio"),
        );
        assert!(profile.starts_with("(version 1)\n(deny default)"));
        assert!(profile.contains("(allow file-write* (subpath \"/w\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/w/reflexion-sandbox\"))"));
        assert!(profile.contains("(subpath \"/Users/tester/.ssh\")"));
        assert!(profile.contains("(subpath \"/Users/tester/.reflexion-os-studio\")"));
        assert!(
            !profile.contains("(allow network"),
            "no network allowance without approval: {profile}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn render_profile_pins_normalized_paths_in_output() {
        // 输出面钉住（与 profile_path 单测互补）：/tmp → /private/tmp 的解析必须真正进入
        // 渲染结果——可写根 allow 与 data_dir deny 两侧都要规范化，否则内核 vnode 静默失配。
        let profile = render_profile(
            &request(&["/tmp/x-root"], false),
            None,
            Path::new("/tmp/x-data"),
        );
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/tmp/x-root\"))"),
            "writable root must render normalized: {profile}"
        );
        assert!(
            profile.contains("(deny file-read* (subpath \"/private/tmp/x-data\"))"),
            "data_dir deny must render normalized: {profile}"
        );
        assert!(
            !profile.contains("\"/tmp/x-"),
            "raw symlinked path must not leak into profile: {profile}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_path_resolves_symlinked_ancestors_of_missing_leaf() {
        // /var → /private/var，末段不存在也要按现存祖先解析（沙盒临时目录 wrap 时才建）。
        let resolved = profile_path(Path::new("/var/reflexion-sandbox-missing"));
        assert_eq!(
            resolved,
            PathBuf::from("/private/var/reflexion-sandbox-missing")
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

/// 真机验收（spec §11.3，轮次 B 主验证面）：sandbox-exec 实跑，钉死
/// deny-default / 写边界 / 敏感拒读 / 禁网四条核心语义 + 常用工具无连带伤害。
/// probe 失败 = 本机环境异常，大声断言失败（BLOCKED），不得静默跳过。
#[cfg(all(test, target_os = "macos"))]
mod real_machine_tests;
