//! Linux bwrap provider：bubblewrap 命名空间沙箱。
//! 网络：--unshare-all 自带 netns（未批网 → OS 级禁网，审批后 --share-net）。
//! 写：--ro-bind / / 全局只读 + --bind 可写根；敏感路径 --tmpfs 遮蔽（呈现为空目录）。
//! 取消兜底：--die-with-parent 即内核 PDEATHSIG 语义——kill_tree 对 bwrap 进程
//! SIGKILL 后，内核把沙箱内进程一并杀掉；沙箱 init（pid-ns 内 pid 1）退出带走整棵
//! 树。--new-session 防 TIOCSTI 注入（bubblewrap README Limitations / CVE-2017-5226），
//! 代价是脱离外层进程组信号，取消完全依赖 PDEATHSIG 这条收割路径。差异已记入 spec §12.1。
//! 本模块全平台编译（纯 args 渲染 + 干跑探测）；Linux 运行时行为在开发机未验证。
//!
//! 渲染架构：`wrap()` 在 host 侧 stat 文件系统事实（BindFacts），`build_bwrap_args`
//! 是纯函数消费事实——金样单测因此可以在 macOS 开发机上钉住所有分支。
//! 依据 bubblewrap main 源码（setup_newroot 单循环、dest 在 `--ro-bind / /` 之后按
//! argv 序 mkdir）核对的硬约束：缺失的挂载 dest 只在父目录当前可写时补建得了，
//! ro 覆盖下 EROFS 直接退出（fail-closed）。两处事实消费见函数内注释。
//!
//! Linux 真机验收挂起项（静态推理不能替代实测）：
//! - /tmp 常规场景 vs TMPDIR 外指场景下，FIXED_TMP alias 与回退分支各自实测可写；
//! - 遮蔽路径为文件/符号链接时 bwrap 拒绝挂载（fail-closed，命令跑不起来但不泄密）；
//! - PDEATHSIG 树杀等价性（超时 SIGKILL bwrap 后沙箱内无存活）；
//! - --unshare-all 含 cgroup ns：写 /sys/fs/cgroup 的工具（systemd-run 类）会失败，
//!   属可用性项，真机撞上再议 --unshare-cgroup-try 或白名单；
//! - 硬化内核禁非特权 userns → probe 干跑失败 → 降级 none；
//! - bwrap 未安装 → probe 第一级 spawn 失败 → 降级 none。

use std::path::{Path, PathBuf};

use super::{SandboxProvider, SandboxRequest};

const FIXED_TMP: &str = "/tmp/reflexion-sandbox";

#[derive(Clone)]
pub(crate) struct BwrapSandbox {
    home: Option<PathBuf>,
    data_dir: PathBuf,
}

/// host 文件系统事实（wrap 时采集），把「哪些路径存在」从纯渲染器里剥出来。
struct BindFacts {
    /// 敏感遮蔽路径中 host 实际存在的（缺失路径 bwrap 会因只读父挂载 EROFS 失败，
    /// 且不存在即无可遮蔽——存在性过滤同时修复正确性与可用性）。
    masked: Vec<PathBuf>,
    /// FIXED_TMP 在 host 可见时才可把沙盒临时目录别名挂到该固定名（bwrap 虽会
    /// mkdir 缺失 dest，但 EROFS 父挂载下失败，EEXIST 是唯一通路）。false 时仅绑
    /// 原路径，TMPDIR 用原路径。
    fixed_tmp_bindable: bool,
}

impl BwrapSandbox {
    pub(crate) fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let data_dir = std::env::var_os("REFLEXION_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home.clone()
                    .unwrap_or_default()
                    .join(".reflexion-os-studio")
            });
        Self { home, data_dir }
    }

    /// 遮蔽候选 = data_dir + HOME 的凭据目录（与 Seatbelt 同一清单）。
    fn masked_candidates(&self) -> Vec<PathBuf> {
        let mut candidates = vec![self.data_dir.clone()];
        if let Some(home) = &self.home {
            for tail in [".ssh", ".aws", ".gnupg"] {
                candidates.push(home.join(tail));
            }
        }
        candidates
    }

    fn facts(&self) -> BindFacts {
        BindFacts {
            masked: self
                .masked_candidates()
                .into_iter()
                .filter(|path| path.exists())
                .collect(),
            // alias dest 可挂载的前提是 dest 在 host 可见（ro 覆盖树下 bwrap 的
            // mkdirat 只有撞 EEXIST 才过得去）。handler 已在 wrap 前建好
            // sandbox_temp：TMPDIR=/tmp（缺省）时 FIXED_TMP 恰在其位，alias 成立；
            // TMPDIR 外指时 FIXED_TMP 通常不存在，走「仅绑原路径 + TMPDIR 原路径」
            // 回退分支，不在真机上赌 mkdir 能否成功。
            fixed_tmp_bindable: Path::new(FIXED_TMP).exists(),
        }
    }

    /// 探测：bwrap 可用 + userns/netns 干跑成功（硬化内核禁非特权 userns 时降级 none）。
    /// 干跑不含遮蔽/alias 挂载，相关失败（文件/符号链接 dest 拒挂类）探测抓不到，
    /// 真机如确认需把等价 args 纳入 probe。
    pub(crate) fn probe() -> bool {
        std::process::Command::new("bwrap")
            .args(["--version"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
            && std::process::Command::new("bwrap")
                .args(["--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
    }
}

impl SandboxProvider for BwrapSandbox {
    fn id(&self) -> &'static str {
        "bwrap"
    }

    fn is_available(&self) -> bool {
        Self::probe()
    }

    fn wrap(&self, request: &SandboxRequest) -> Option<Vec<String>> {
        Some(build_bwrap_args(request, &self.facts()))
    }
}

/// 纯函数渲染（单测金样钉住；开发机不执行 bwrap；host 存在性事实经 BindFacts 注入）。
/// 模块私有：BindFacts 是私有事实类型，公开签名会触发 private_interfaces。
fn build_bwrap_args(request: &SandboxRequest, facts: &BindFacts) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "bwrap".into(),
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
    ];
    // 可写根（handler 约定：[workspace_root, sandbox_temp]，wrap 前已 create_dir_all）。
    for root in &request.writable_roots {
        let text = root.to_string_lossy().into_owned();
        args.extend(["--bind".into(), text.clone(), text]);
    }
    // TMPDIR 重定向两分支：dest 可达时沙盒临时目录双挂载（原路径 + 固定名），
    // 子进程看到稳定路径；否则回退原路径（上一步已按可写根绑好，不丢功能）。
    let sandbox_tmpdir = match (facts.fixed_tmp_bindable, request.writable_roots.last()) {
        (true, Some(temp)) => {
            args.extend([
                "--bind".into(),
                temp.to_string_lossy().into_owned(),
                FIXED_TMP.into(),
            ]);
            FIXED_TMP.to_string()
        }
        (false, Some(temp)) => temp.to_string_lossy().into_owned(),
        // 退化输入（handler 约定下不会发生）：无沙盒临时目录可指，维持固定名占位。
        (_, None) => FIXED_TMP.to_string(),
    };
    // 敏感路径遮蔽为空 tmpfs（读不到内容即达标）。保持 flag 顺序：--tmpfs 在
    // --bind 之后，bwrap 按序挂载，同一路径上 tmpfs 盖住可写 bind 是有意为之——
    // 遮蔽优先。
    for path in &facts.masked {
        args.extend(["--tmpfs".into(), path.to_string_lossy().into_owned()]);
    }
    args.extend(["--tmpfs".into(), "/dev/shm".into()]);
    // 网络：OS 级禁断是 Linux 档强项；仅审批通过后共享。
    args.push("--unshare-all".into());
    if request.allow_network {
        args.push("--share-net".into());
    }
    args.extend([
        "--die-with-parent".into(),
        "--new-session".into(),
        "--setenv".into(),
        "TMPDIR".into(),
        sandbox_tmpdir,
        "--".into(),
        "/bin/sh".into(),
        "-c".into(),
        request.command.clone(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_MASKS: &[&str] = &["/home/t/.ssh", "/home/t/.aws", "/home/t/.gnupg", "/data"];

    fn request(allow_network: bool) -> SandboxRequest {
        SandboxRequest {
            command: "echo hi".to_string(),
            cwd: PathBuf::from("/w"),
            timeout_ms: 1000,
            allow_network,
            writable_roots: vec![
                PathBuf::from("/w"),
                PathBuf::from("/tmp-x/reflexion-sandbox"),
            ],
        }
    }

    fn facts(masked: &[&str], bindable: bool) -> BindFacts {
        BindFacts {
            masked: masked.iter().map(PathBuf::from).collect(),
            fixed_tmp_bindable: bindable,
        }
    }

    fn joined(f: &BindFacts) -> String {
        build_bwrap_args(&request(false), f).join("\u{1}")
    }

    #[test]
    fn root_is_read_only_with_scoped_writable_binds() {
        // 前缀钉住全局只读 + dev/proc。注：计划原样断言
        // "--ro-bind\u{1}/\u{1}/\u{1}/" 永假（渲染器第 4 元素是 --dev 非 "/"；
        // 断言与渲染器同出自一份计划但互斥），按渲染器为准钉完整前缀。
        let args = joined(&facts(FULL_MASKS, true));
        assert!(args.starts_with(
            "bwrap\u{1}--ro-bind\u{1}/\u{1}/\u{1}--dev\u{1}/dev\u{1}--proc\u{1}/proc"
        ));
        assert!(args.contains("--bind\u{1}/w\u{1}/w"));
        assert!(args.contains("--bind\u{1}/tmp-x/reflexion-sandbox\u{1}/tmp-x/reflexion-sandbox"));
        assert!(args.contains(&format!(
            "--bind\u{1}/tmp-x/reflexion-sandbox\u{1}{FIXED_TMP}"
        )));
    }

    #[test]
    fn masks_render_exactly_for_existing_paths_it_receives() {
        // 给定事实 → 逐条 --tmpfs（且排在可写 bind 之后，遮蔽优先）。
        let f = facts(FULL_MASKS, false);
        let args = build_bwrap_args(&request(false), &f);
        let joined_str = args.join("\u{1}");
        for masked in FULL_MASKS {
            assert!(
                joined_str.contains(&format!("--tmpfs\u{1}{masked}")),
                "missing mask for {masked}"
            );
        }
        // 顺序钉（安全相关）：bwrap 按 argv 序挂载，遮蔽 --tmpfs 必须排在最后一条
        // --bind 之后——同路径上后挂的 tmpfs 盖住先挂的可写 bind（mask wins）。
        // 若有人把遮蔽挪到 bind 前，可写根恰好嵌套敏感路径时遮蔽会被反盖。
        let last_bind = args.iter().rposition(|a| a == "--bind").unwrap();
        let first_tmpfs = args.iter().position(|a| a == "--tmpfs").unwrap();
        assert!(
            first_tmpfs > last_bind,
            "masks must mount after all binds: first --tmpfs@{first_tmpfs} <= last --bind@{last_bind}"
        );
        // 未给事实（host 不存在、wrap 已过滤）→ 只剩 /dev/shm 一条 tmpfs。
        let bare = joined(&facts(&[], false));
        assert_eq!(bare.matches("--tmpfs").count(), 1);
        assert!(bare.contains("--tmpfs\u{1}/dev/shm"));
    }

    #[test]
    fn wrap_skips_sensitive_paths_that_do_not_exist() {
        // 事实采集侧（本模块唯一碰文件系统处）：不存在的 HOME/data_dir 不产遮蔽，
        // 也不产 "/None" 之类病态路径（原金样语义迁移）。
        let sandbox = BwrapSandbox {
            home: Some(PathBuf::from("/no-such-home-for-bwrap-test")),
            data_dir: PathBuf::from("/no-such-data-for-bwrap-test"),
        };
        let flat = sandbox.wrap(&request(false)).unwrap().join("\u{1}");
        assert!(!flat.contains("no-such-home-for-bwrap-test"));
        assert!(!flat.contains("no-such-data-for-bwrap-test"));
        assert!(!flat.contains("None"));
    }

    #[test]
    fn fixed_tmp_alias_only_when_dest_is_bindable() {
        // bindable：双挂载 alias + 子进程 TMPDIR 用固定名。
        let alias = build_bwrap_args(&request(false), &facts(&[], true));
        let alias_str = alias.join("\u{1}");
        assert!(alias_str.contains(&format!(
            "--bind\u{1}/tmp-x/reflexion-sandbox\u{1}{FIXED_TMP}"
        )));
        assert!(alias_str.contains(&format!("--setenv\u{1}TMPDIR\u{1}{FIXED_TMP}")));
        // 不可达：不加 alias bind，TMPDIR 回退沙盒临时目录原路径。
        let fallback = build_bwrap_args(&request(false), &facts(&[], false));
        let fallback_str = fallback.join("\u{1}");
        assert!(
            !fallback_str.contains(&format!(
                "--bind\u{1}/tmp-x/reflexion-sandbox\u{1}{FIXED_TMP}\u{1}"
            )),
            "no alias bind when {FIXED_TMP} not bindable: {fallback_str}"
        );
        assert!(fallback_str.contains("--setenv\u{1}TMPDIR\u{1}/tmp-x/reflexion-sandbox"));
        // 顺序钉（两分支）：--setenv 必须在 `--` 终止符之前（其后即子命令，flag
        // 会被 sh 当参数吃掉）。不钉 --setenv vs --unshare-all 相对序：env 在 exec
        // 时才生效，该相对序对 bwrap 无语义（已核对渲染器输出确实 setenv 在后，
        // 但只作形状记录，不作安全不变量——真正的安全不变量是挂载序与 share-net 序）。
        for args in [&alias, &fallback] {
            let setenv = args.iter().position(|a| a == "--setenv").unwrap();
            let terminator = args.iter().position(|a| a == "--").unwrap();
            assert!(
                setenv < terminator,
                "--setenv must precede the `--` terminator: {setenv} >= {terminator}"
            );
        }
    }

    #[test]
    fn network_shared_only_after_approval() {
        let f = facts(FULL_MASKS, true);
        assert!(joined(&f).contains("--unshare-all"));
        assert!(!joined(&f).contains("--share-net"));
        // 顺序钉（安全相关）：bwrap 解析循环里 --unshare-all 是**赋值**整组
        // namespace flags，--share-net 是清 net 位——--share-net 排在
        // --unshare-all 之前会被覆盖回禁网（审批后反而没网）。
        let approved = build_bwrap_args(&request(true), &f);
        assert!(approved.join("\u{1}").contains("--share-net"));
        let unshare_all = approved.iter().position(|a| a == "--unshare-all").unwrap();
        let share_net = approved.iter().position(|a| a == "--share-net").unwrap();
        assert!(
            share_net > unshare_all,
            "--share-net must follow --unshare-all: {share_net} <= {unshare_all}"
        );
    }

    #[test]
    fn terminates_with_sh_command_and_safety_flags() {
        let args = build_bwrap_args(&request(false), &facts(&["/d"], true));
        let flat = args.join("\u{1}");
        assert!(flat.contains("--die-with-parent"));
        assert!(flat.contains("--new-session"));
        assert!(flat.contains(&format!("--setenv\u{1}TMPDIR\u{1}{FIXED_TMP}")));
        assert_eq!(
            &args[args.len() - 4..],
            ["--", "/bin/sh", "-c", "echo hi"]
                .map(String::from)
                .as_slice()
        );
    }
}
