# 终端 GUI 人工验收清单（W4-3）

> 供人类在**打包版或 dev 桌面应用**中逐项执行；自动化部分（协议链路、故障矩阵、
> 性能门槛、打包冒烟）见 `docs/TERMINAL-SPIKE-REPORT.md` §2/§9/§11/§12，此处不重复。
> 每项填「结果」列：PASS / FAIL（附现象）/ 跳过（附原因）。日期与 OS 版本记在文末。

| #   | 项目                       | 步骤                                                                                                                                                             | 预期                                                                                                                                   | 结果（待填） |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | 启动与新建                 | 打开聊天页 → 顶栏终端按钮展开面板 → 点 ＋ 新建终端 → 输入 `echo hi` 回车                                                                                         | 面板打开、出现 shell 标签、命令回显正常、光标在提示符                                                                                  |              |
| 2   | 跨页面/跨项目保活 + resize | 终端里运行 `vim` 或 `top` → 切到技能/设置页再回聊天 → 收起面板再展开 → 拖动面板上沿改高度 → 切换到另一项目再切回                                                 | 实例不重建、输出不丢、vim/top 重显后画面正确（可能需按一次回车重绘）；高度变化只触发一次 resize；切回项目标签仍在且激活项正确          |              |
| 3   | Ctrl+C 与交互程序          | 运行 `top`，按 Ctrl+C → 再运行 `ping localhost`，按 Ctrl+C                                                                                                       | 前台程序被中断、shell 提示符恢复、终端不卡死                                                                                           |              |
| 4   | 粘贴上限                   | 复制 >1 MiB 文本（如 `openssl rand -base64 2000000` 输出）粘贴进终端；再粘贴一段 <1 MiB 的多行文本                                                               | 超限粘贴被整体**拒绝**并有 toast「粘贴内容超过 1 MiB，已拒绝（不截断发送）」，shell 不收到残包；正常粘贴完整落入 shell、回车后执行正常 |              |
| 5   | 退出与重新创建             | 在终端输入 `exit` → 观察标签；点死标签的 ⟳ 重新创建                                                                                                              | 标签变灰并显示退出码 chip（signal 显示 `signal`）；⟳ 后新终端原位替换、旧标签消失                                                      |              |
| 6   | Runtime 崩溃恢复           | `kill -9` reflexion-system-runtime 进程（`pgrep -fl reflexion-system-runtime` 找 PID）→ 回面板观察 → 点 ⟳ 重建                                                   | 所有标签显示「已断开」chip；sidecar 自动重启后重建的终端可正常输入输出                                                                 |              |
| 7   | 带终端删除项目             | 项目内开着 ≥1 个终端 → 侧栏删除该项目                                                                                                                            | 确认文案如实提示"该项目有 N 个终端将被关闭"；确认后项目、标签、shell 进程一并消失（`pgrep -fl <shell名>` 无残留）                      |              |
| 8   | 额度提示                   | 单项目连开终端至上限（8/项目），再继续点 ＋；再跨项目开至全局 16                                                                                                 | 触发 toast：「本项目终端数量已达上限…」（项目额度）/「全局终端数量已达上限…」（全局）；不静默失败、不创建幽灵标签                      |              |
| 9   | 空闲 CPU                   | 开着 1 个空闲终端（不洪泛）放置 ≥30s，活动监视器/`top` 看 WebView 渲染进程与 Tauri 宿主、node Runtime                                                            | 三进程空闲 CPU ≈0%（AGENTS §11 底线）；内存无持续增长                                                                                  |              |
| 10  | 入口禁用开关               | DevTools 执行 `localStorage.setItem('terminal.forceDisabled','1')` → **重启应用** → 看顶栏；聊天里确认其他功能不受影响；随后 `localStorage.removeItem(...)` 恢复 | 顶栏终端按钮消失、无法新建终端；构建期开关等价验证：`VITE_TERMINAL_DISABLED=1 pnpm build:packages` 起的 dev/包同样隐藏入口             |              |

## 执行记录

| 项            | 值                                           |
| ------------- | -------------------------------------------- |
| 执行人 / 日期 | （待填）                                     |
| OS / 版本     | （待填，如 macOS 26.6.2 + 打包版 0.1.0）     |
| 加载形态      | （dev / 安装包，待填）                       |
| 结论          | （待填：x/10 PASS；FAIL 项附截图或现象描述） |

## Shell 环境一致性（2026-10-11）

- macOS：zsh、bash、fish、ksh 使用独立 argv 参数 `-l -i`；Linux 使用 `-i`，与常见图形终端的非登录交互模式一致，避免跳过 `.bashrc`。sh/dash 只传 `-i`，避免把不支持的登录参数传给 Linux dash；未知 shell 不猜测参数。
- Windows：保留优先 pwsh、其次 Windows PowerShell 的交互启动，加载其默认 profile；不添加 Unix 登录参数。
- Unix 有效且可执行的 SHELL 优先，否则通过系统账户 API 获取默认 Shell，再回退 sh；不直接读取账户文件。Runtime 环境快照同样采用账户 API 回退，macOS 探测使用登录交互模式，Linux 使用交互模式。保留 Runtime 的用户环境快照与继承链；PTY 设置自己的 TERM、TERM_PROGRAM、TERM_PROGRAM_VERSION、COLORTERM。启动终端时不清空 PATH 或工具链变量。
- 创建前检查 cwd 是绝对路径、存在且为目录。portable-pty 对非法 cwd 可能回退 HOME，现改为明确报错。只读目录仍可打开终端，不执行写入探测，不据此承诺 Cargo 能在目录内构建。
- 自动测试以隔离的 HOME/ZDOTDIR 和测试 profile 对比对应平台的外部 zsh/bash 与真实 PTY（macOS `-l -i`，Linux `-i`，并在 macOS 上额外模拟 Linux 参数），验证登录/交互配置、cargo/pnpm 查找路径和 cwd；不读取用户 profile 或打印完整环境。

真机复验：从 Finder 打开打包应用，在同一项目目录新建终端，与外部终端比较以下有限诊断（不执行 `env`、不打印凭据）：

```sh
printf 'shell=%s\nterm=%s\nprogram=%s\npwd=%s\n' "$SHELL" "$TERM" "$TERM_PROGRAM" "$PWD"
command -v cargo
command -v pnpm
```

随后执行原本失败的构建命令。Shell/PATH 一致不等于操作系统权限一致；若仍出现 EPERM，记录具体失败的操作和路径，核对文件权限、ACL、系统隐私授权及可执行文件限制，不直接认定缓存或 TCC 是根因。

当前应用未启用 macOS App Sandbox。security-scoped bookmark 是沙箱资源访问机制，缺少 bookmark 不能独立证明 TCC 拒绝；Tauri `dialog:allow-open` 是前端命令权限，也不等价于操作系统目录权限。参考 [Apple security-scoped bookmark 文档](https://developer.apple.com/documentation/professional-video-applications/enabling-security-scoped-bookmark-and-url-access) 与 [文件与文件夹隐私权限](https://support.apple.com/en-lamr/guide/mac-help/mchld5a35146/27/mac/27)。

本次自动 PTY 对比在 macOS 通过；Finder/TCC 场景、Windows 与 Linux 真机验收仍需执行。
