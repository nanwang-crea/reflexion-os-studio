//! sidecar 路径解析：打包资源目录 vs 开发态仓库回退的差异在此收敛。
//! 可执行文件查找同时尝试带/不带 `.exe` 后缀（Windows）。

use std::path::{Path, PathBuf};

/// 打包资源在安装包 resource_dir 下的子目录名（与 tauri.conf.json 的
/// bundle.resources 目标名一致）。
pub(super) const PACKAGED_RESOURCES_DIR: &str = "pkg";

pub(super) fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

/// TS Runtime 入口：打包态用随包单文件 runtime.mjs，开发态回退仓库 tsc 产物。
fn resolve_runtime_entry(resources: Option<&Path>, root: &Path) -> PathBuf {
    if let Some(resources) = resources {
        let packaged = resources
            .join(PACKAGED_RESOURCES_DIR)
            .join("runtime")
            .join("runtime.mjs");
        if packaged.exists() {
            return packaged;
        }
    }
    root.join("apps")
        .join("runtime")
        .join("dist")
        .join("index.js")
}

/// Node 可执行文件：打包态用随包 Node（目标机器无需预装），开发态回退 PATH。
fn resolve_node(resources: Option<&Path>) -> PathBuf {
    if let Some(resources) = resources {
        let base = resources
            .join(PACKAGED_RESOURCES_DIR)
            .join("node")
            .join("bin")
            .join("node");
        let mut with_exe = base.clone().into_os_string();
        with_exe.push(".exe");
        for candidate in [base, PathBuf::from(with_exe)] {
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

/// sidecar 工作目录：打包态用资源目录（目标机器上仓库路径不存在，
/// current_dir 指向不存在目录会导致 spawn 失败），开发态用仓库根。
fn sidecar_cwd(resources: Option<&Path>, root: &Path) -> PathBuf {
    resources
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.to_path_buf())
}

/// Rust System Runtime 二进制解析（宿主只负责找到路径并交给 TS，
/// spawn/监管由 TS 承担）：env 覆盖优先，其次打包资源目录（带 .exe 变体），
/// 最后仓库相对路径（开发态）。
fn resolve_system_runtime(root: &Path, resources: Option<&Path>) -> Option<PathBuf> {
    std::env::var_os("REFLEXION_SYSTEM_RUNTIME")
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            resources.and_then(|resources| {
                let base = resources
                    .join(PACKAGED_RESOURCES_DIR)
                    .join("bin")
                    .join("reflexion-system-runtime");
                let mut with_exe = base.clone().into_os_string();
                with_exe.push(".exe");
                [base, PathBuf::from(with_exe)]
                    .into_iter()
                    .find(|path| path.exists())
            })
        })
        .or_else(|| {
            [
                "target/debug",
                "crates/target/debug",
                "target/release",
                "crates/target/release",
            ]
            .into_iter()
            .map(|dir| root.join(dir).join("reflexion-system-runtime"))
            .flat_map(|path| {
                let mut with_exe = path.clone().into_os_string();
                with_exe.push(".exe");
                [path, PathBuf::from(with_exe)]
            })
            .find(|path| path.exists())
        })
}

/// 解析出的 TS Runtime 启动参数（打包/开发态差异在此收敛）。崩溃重启复用它，
/// 避免每次重算路径与 Node 解析。
#[derive(Clone)]
pub(super) struct RuntimeLaunchConfig {
    pub node: PathBuf,
    pub args: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
}

pub(super) fn resolve_runtime_launch_config(
    resources: Option<&Path>,
    root: &Path,
) -> Option<RuntimeLaunchConfig> {
    let runtime_entry = resolve_runtime_entry(resources, root);
    if !runtime_entry.exists() {
        return None;
    }
    let node = resolve_node(resources);
    // node:sqlite 在 Node 22 仍标 experimental：产品进程抑制该已知警告，
    // 避免被误读为真正的运行时报错（stderr 仍是日志通道）。
    let args = vec![
        PathBuf::from("--disable-warning=ExperimentalWarning"),
        runtime_entry,
    ];
    let cwd = sidecar_cwd(resources, root);
    // Rust 二进制路径经环境变量交接给 TS；找不到则照常启动（TS 会按
    // runtime.status 上报 degraded，工具不可用但不阻塞 Chat）。
    let envs = resolve_system_runtime(root, resources)
        .map(|path| {
            vec![(
                "REFLEXION_SYSTEM_RUNTIME_BIN".to_string(),
                path.display().to_string(),
            )]
        })
        .unwrap_or_default();
    Some(RuntimeLaunchConfig {
        node,
        args,
        cwd,
        envs,
    })
}

/// 孤儿清理 marker：同时收录仓库路径的原始形态与规范化形态——宿主 spawn 的
/// sidecar 命令行带未规范化的 `../..`（repo_root 原样拼接），孤儿恰是该形态；
/// 手动/其他来源的进程则是干净路径。resource_dir 由 Tauri 返回时已规范化。
/// 终端用户机器上仓库路径不存在，dev marker 无进程命中，天然无害。
pub(super) fn orphan_cleanup_markers(resources: Option<&Path>) -> Vec<String> {
    let mut markers = vec![repo_root().display().to_string()];
    if let Ok(canon) = std::fs::canonicalize(repo_root()) {
        markers.push(canon.display().to_string());
    }
    if let Some(resources) = resources {
        if let Ok(canon) = std::fs::canonicalize(resources) {
            markers.push(canon.display().to_string());
        }
    }
    markers.sort();
    markers.dedup();
    markers
}
