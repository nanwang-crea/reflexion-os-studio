use super::*;
use crate::sandbox::SandboxAccess;
use crate::shell;
use std::process::Command;

const SENTINEL: &str = "SENTINEL-SECRET-DO-NOT-LEAK";

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    fake_home: PathBuf,
    fake_data: PathBuf,
    sandbox_temp: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 假 HOME / 假数据目录 / 沙盒临时目录全部落在受控 temp 内，绝不影响真实 HOME。
fn fixture(tag: &str) -> Fixture {
    let root = shell::temp_dir(&format!("seatbelt-{tag}"));
    let workspace = root.join("workspace");
    let fake_home = root.join("home");
    let fake_data = root.join("data");
    let sandbox_temp = root.join("sandbox-temp");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(fake_home.join(".ssh")).unwrap();
    std::fs::write(fake_home.join(".ssh/id_marker"), b"private-key-material").unwrap();
    std::fs::write(fake_home.join("plain.txt"), b"plain-readable").unwrap();
    std::fs::create_dir_all(&fake_data).unwrap();
    std::fs::write(
        fake_data.join("secrets.json"),
        format!(r#"{{"apiKey":"{SENTINEL}"}}"#),
    )
    .unwrap();
    std::fs::create_dir_all(&sandbox_temp).unwrap();
    Fixture {
        root,
        workspace,
        fake_home,
        fake_data,
        sandbox_temp,
    }
}

/// 与生产 handler 同构：build_argv → execute_argv + TMPDIR 重定向 → 沙盒内 sh -c。
fn run(
    fx: &Fixture,
    command: &str,
    allow_network: bool,
    extra_writable: &[PathBuf],
    timeout_ms: u64,
) -> shell::ShellOutcome {
    let mut writable_roots = vec![fx.workspace.clone(), fx.sandbox_temp.clone()];
    writable_roots.extend_from_slice(extra_writable);
    let request = SandboxRequest {
        command: command.to_string(),
        cwd: fx.workspace.clone(),
        timeout_ms,
        allow_network,
        access: SandboxAccess::WorkspaceWrite,
        writable_roots,
    };
    let sandbox = SeatbeltSandbox {
        home: Some(fx.fake_home.clone()),
        data_dir: fx.fake_data.clone(),
    };
    let argv = sandbox.build_argv(&request);
    shell::execute_argv(
        &argv,
        &[("TMPDIR", fx.sandbox_temp.display().to_string())],
        &fx.workspace,
        timeout_ms,
        &|_| {},
    )
    .expect("sandbox-exec must spawn")
}

/// 档位维度真机执行：调用方给出 access 与完整可写根集合（模拟 handler 装配）。
fn run_access(
    fx: &Fixture,
    command: &str,
    access: SandboxAccess,
    writable_roots: &[PathBuf],
    timeout_ms: u64,
) -> shell::ShellOutcome {
    let request = SandboxRequest {
        command: command.to_string(),
        cwd: fx.workspace.clone(),
        timeout_ms,
        allow_network: false,
        access,
        writable_roots: writable_roots.to_vec(),
    };
    let sandbox = SeatbeltSandbox {
        home: Some(fx.fake_home.clone()),
        data_dir: fx.fake_data.clone(),
    };
    let argv = sandbox.build_argv(&request);
    shell::execute_argv(
        &argv,
        &[("TMPDIR", fx.sandbox_temp.display().to_string())],
        &fx.workspace,
        timeout_ms,
        &|_| {},
    )
    .expect("sandbox-exec must spawn")
}

fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

fn binary_available(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 确定性禁网探针：127.0.0.1:9（discard 端口，通常关闭），无外网依赖。
/// 沙箱内 connect 被 seatbelt 拒 → EPERM；放行后 → ECONNREFUSED，可区分。
/// python3 优先：其 traceback 直接暴露 errno 字符串；真机 curl 8.7.1 把 EPERM 与
/// ECONNREFUSED 一并打印为 "Couldn't connect to server"，无法钉死验收断言。
fn connect_probe_command() -> String {
    if binary_available("python3") {
        "python3 -c 'import socket; s = socket.socket(); s.settimeout(8); s.connect((\"127.0.0.1\", 9))'".to_string()
    } else if binary_available("curl") {
        "curl -sS -m 8 http://127.0.0.1:9".to_string()
    } else {
        panic!("BLOCKED: neither python3 nor curl available for the network-deny probe")
    }
}

#[test]
fn probe_must_succeed_on_this_machine() {
    assert!(
        SeatbeltSandbox::probe(),
        "BLOCKED: /usr/bin/sandbox-exec missing or dry-run failed on this macOS; \
             every other real-machine assertion below is moot"
    );
}

#[test]
fn echo_regression() {
    let fx = fixture("echo");
    let outcome = run(&fx, "printf hello", false, &[], 20_000);
    assert_eq!(outcome.exit_code, Some(0), "stderr: {}", outcome.stderr);
    assert_eq!(outcome.stdout, "hello");
}

#[test]
fn write_escape_denied() {
    let fx = fixture("escape");
    let escape = fx.fake_home.join("escape.txt");
    let outcome = run(
        &fx,
        &format!("touch {}", quoted(&escape)),
        false,
        &[],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "write outside boundary must fail, stderr: {}",
        outcome.stderr
    );
    assert!(!escape.exists(), "escape file must not be created");
}

#[test]
fn in_boundary_writes_allowed() {
    let fx = fixture("inside");
    let outcome = run(&fx, "touch inside.txt", false, &[], 20_000);
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "workspace write must succeed, stderr: {}",
        outcome.stderr
    );
    assert!(fx.workspace.join("inside.txt").exists());

    let outcome = run(
        &fx,
        "touch \"$TMPDIR/in-sandbox-temp.txt\"",
        false,
        &[],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "sandbox temp write must succeed, stderr: {}",
        outcome.stderr
    );
    assert!(fx.sandbox_temp.join("in-sandbox-temp.txt").exists());
}

#[test]
fn sensitive_read_denied_sibling_read_allowed() {
    let fx = fixture("deny-read");
    let secrets = fx.fake_data.join("secrets.json");
    let outcome = run(
        &fx,
        &format!("cat {}", quoted(&secrets)),
        false,
        &[],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "reading data_dir secrets must fail, stderr: {}",
        outcome.stderr
    );
    assert!(
        !outcome.stdout.contains(SENTINEL),
        "secret sentinel leaked into stdout"
    );
    // 对照组钉住策略形状：除拒读清单外读取大体放开（可用性优先，codex 同档）。
    let plain = fx.fake_home.join("plain.txt");
    let outcome = run(&fx, &format!("cat {}", quoted(&plain)), false, &[], 20_000);
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "sibling read must stay allowed, stderr: {}",
        outcome.stderr
    );
    assert!(outcome.stdout.contains("plain-readable"));
}

#[test]
fn network_denied_without_approval() {
    let fx = fixture("net-deny");
    let outcome = run(&fx, &connect_probe_command(), false, &[], 20_000);
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "connect must fail without approval, stderr: {}",
        outcome.stderr
    );
    // EPERM 判别只在 python3 路线成立：curl 8.7.1 把 EPERM 与 ECONNREFUSED 一律
    // 打印为 "Couldn't connect to server"，curl 回退路线仅以上方非零退出为断言。
    if binary_available("python3") {
        assert!(
            outcome.stderr.contains("Operation not permitted"),
            "expected seatbelt connect denial (EPERM), not ECONNREFUSED: {}",
            outcome.stderr
        );
    }
}

#[test]
fn network_proceeds_with_approval() {
    let fx = fixture("net-allow");
    let outcome = run(&fx, &connect_probe_command(), true, &[], 20_000);
    assert!(
        !outcome.stderr.contains("Operation not permitted"),
        "approved network must not hit seatbelt denial: {}",
        outcome.stderr
    );
    // 仅「无 EPERM」不充分：probe 在 connect 之前夭折（解释器炸、参数错）同样静默。
    // 127.0.0.1:9 通常无人监听 → 放行后必须看到 ECONNREFUSED（python3 路由为
    // ConnectionRefusedError / [Errno 61]，curl 路由为 Connection refused）。
    // 极端情况端口真被监听则 connect 成功、exit 0，同样算到达 socket 层。
    if outcome.exit_code != Some(0) {
        let reached_socket_layer = outcome.stderr.contains("ConnectionRefusedError")
            || outcome.stderr.contains("[Errno 61]")
            || outcome.stderr.contains("Connection refused");
        assert!(
            reached_socket_layer,
            "probe must reach the socket layer (ECONNREFUSED expected on 127.0.0.1:9): {}",
            outcome.stderr
        );
    }
}

#[test]
fn timeout_survives_wrapping() {
    // sandbox-exec exec 替换自身 → pgid 不变，kill(-pgid) 仍能收掉沙箱内 sleep。
    let fx = fixture("timeout");
    let started = std::time::Instant::now();
    let outcome = run(&fx, "sleep 30", false, &[], 500);
    assert!(outcome.timed_out, "stderr: {}", outcome.stderr);
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn common_tools_no_collateral() {
    let fx = fixture("tools");
    for command in ["git --version", "ls /"] {
        let outcome = run(&fx, command, false, &[], 20_000);
        assert_eq!(
            outcome.exit_code,
            Some(0),
            "`{command}` collateral damage: {}",
            outcome.stderr
        );
    }
    if binary_available("python3") {
        let outcome = run(&fx, "python3 -c 'print(1)'", false, &[], 20_000);
        assert_eq!(
            outcome.exit_code,
            Some(0),
            "python3 collateral damage: {}",
            outcome.stderr
        );
        assert_eq!(outcome.stdout.trim(), "1");
    } else {
        eprintln!("SKIP python3 check: python3 not installed on this machine");
    }
}

#[test]
fn git_repo_status_and_local_config_succeed() {
    let fx = fixture("git-repo");
    let repo = fx.workspace.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let init = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .expect("host-side git init");
    assert!(init.success());
    let cd_repo = format!("cd {}", quoted(&repo));
    let outcome = run(
        &fx,
        &format!("{cd_repo} && git status"),
        false,
        &[repo.clone()],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "git status (.git writes) must succeed: {}",
        outcome.stderr
    );
    let outcome = run(
        &fx,
        &format!("{cd_repo} && git config user.email x@y"),
        false,
        &[repo.clone()],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "repo-local git config must succeed: {}",
        outcome.stderr
    );
    let config = std::fs::read_to_string(repo.join(".git/config")).unwrap();
    assert!(config.contains("x@y"), "local config not written: {config}");
}

#[test]
fn read_only_tier_denies_workspace_write_allows_temp() {
    // read-only 档：handler 只装配 [sandbox_temp] 可写根（无 workspace）。
    let fx = fixture("tier-readonly");
    let outcome = run_access(
        &fx,
        "touch inside.txt",
        SandboxAccess::ReadOnly,
        &[fx.sandbox_temp.clone()],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "read-only tier must deny workspace write: {}",
        outcome.stderr
    );
    assert!(!fx.workspace.join("inside.txt").exists());
    // 沙盒临时目录仍可写（工具正常落地中间文件）。
    let outcome = run_access(
        &fx,
        "touch \"$TMPDIR/ok.txt\"",
        SandboxAccess::ReadOnly,
        &[fx.sandbox_temp.clone()],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "read-only tier must allow sandbox temp: {}",
        outcome.stderr
    );
}

#[test]
fn escalated_tier_opens_only_approved_root() {
    // escalated 档：仅额外批准的目录可写，其它工作区外路径仍拒。
    let fx = fixture("tier-escalated");
    let approved = fx.root.join("approved");
    std::fs::create_dir_all(&approved).unwrap();
    let denied_dir = fx.root.join("not-approved");
    std::fs::create_dir_all(&denied_dir).unwrap();
    let outcome = run_access(
        &fx,
        &format!("touch {}", quoted(&approved.join("ok.txt"))),
        SandboxAccess::Escalated,
        &[
            fx.workspace.clone(),
            fx.sandbox_temp.clone(),
            approved.clone(),
        ],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "approved root must be writable: {}",
        outcome.stderr
    );
    let outcome = run_access(
        &fx,
        &format!("touch {}", quoted(&denied_dir.join("no.txt"))),
        SandboxAccess::Escalated,
        &[fx.workspace.clone(), fx.sandbox_temp.clone(), approved],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "non-approved outside path must stay denied even when escalated: {}",
        outcome.stderr
    );
}

#[test]
fn escalated_still_denies_sensitive_read() {
    // 提权不关闭敏感拒读：secrets.json 与 .ssh 私钥即使在 escalated 档仍读不到。
    let fx = fixture("tier-esc-sensitive");
    let approved = fx.root.join("approved");
    std::fs::create_dir_all(&approved).unwrap();
    let outcome = run_access(
        &fx,
        &format!("cat {}", quoted(&fx.fake_data.join("secrets.json"))),
        SandboxAccess::Escalated,
        &[
            fx.workspace.clone(),
            fx.sandbox_temp.clone(),
            approved.clone(),
        ],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "escalated must not open data_dir reads: {}",
        outcome.stderr
    );
    assert!(
        !outcome.stdout.contains(SENTINEL),
        "secret leaked under escalated tier"
    );
    let outcome = run_access(
        &fx,
        &format!("cat {}", quoted(&fx.fake_home.join(".ssh/id_marker"))),
        SandboxAccess::Escalated,
        &[fx.workspace.clone(), fx.sandbox_temp.clone(), approved],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "escalated must not open .ssh reads: {}",
        outcome.stderr
    );
}

#[test]
fn escalated_broad_root_still_denies_sensitive_write() {
    // 提权根粗粒度覆盖凭据目录祖先时，profile 尾部的敏感写 deny 仍压住。
    let fx = fixture("tier-esc-broad");
    let outcome = run_access(
        &fx,
        &format!("touch {}", quoted(&fx.fake_home.join(".ssh/pwned"))),
        SandboxAccess::Escalated,
        &[fx.root.clone()],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "broad escalated root must not permit credential-dir writes: {}",
        outcome.stderr
    );
    assert!(!fx.fake_home.join(".ssh/pwned").exists());
}

#[test]
fn danger_tier_opens_system_scope_but_keeps_credential_guard() {
    // W5 完成定义：danger = 最大非敏感系统访问 + credential guard，不是裸执行。
    let fx = fixture("tier-danger");
    let outside = fx.root.join("outside-danger");
    std::fs::create_dir_all(&outside).unwrap();
    let outcome = run_access(
        &fx,
        &format!("touch {}", quoted(&outside.join("ok.txt"))),
        SandboxAccess::Danger,
        &[],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "danger tier must permit non-sensitive system writes: {}",
        outcome.stderr
    );
    assert!(outside.join("ok.txt").exists());
    // 机密读：即使在 danger 档仍被 OS 拒绝（尾部 deny 压过全局 allow）。
    let outcome = run_access(
        &fx,
        &format!("cat {}", quoted(&fx.fake_data.join("secrets.json"))),
        SandboxAccess::Danger,
        &[],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "danger must not open credential reads: {}",
        outcome.stderr
    );
    assert!(
        !outcome.stdout.contains(SENTINEL),
        "secret sentinel leaked under danger tier"
    );
    // 机密写：同样被尾部 deny 压住。
    let outcome = run_access(
        &fx,
        &format!("touch {}", quoted(&fx.fake_home.join(".ssh/pwned"))),
        SandboxAccess::Danger,
        &[],
        20_000,
    );
    assert_ne!(
        outcome.exit_code,
        Some(0),
        "danger must not open credential writes: {}",
        outcome.stderr
    );
    assert!(!fx.fake_home.join(".ssh/pwned").exists());
    // 非敏感 sibling 读在 danger 档保持可用（对照 deny 的精准性）。
    let outcome = run_access(
        &fx,
        &format!("cat {}", quoted(&fx.fake_home.join("plain.txt"))),
        SandboxAccess::Danger,
        &[],
        20_000,
    );
    assert_eq!(
        outcome.exit_code,
        Some(0),
        "non-sensitive read must work under danger: {}",
        outcome.stderr
    );
}
