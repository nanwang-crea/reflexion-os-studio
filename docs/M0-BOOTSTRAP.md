# M0 Bootstrap

M0 的范围：启动界面、sidecar 生命周期和最小状态握手。M0 之后已进入 Chat Core / Agent 阶段，
本文保留作为启动语义的参考。

## 进程归属（方案 A）

```text
Tauri Host
→ spawn TypeScript Runtime（env 交接 REFLEXION_SYSTEM_RUNTIME_BIN 与数据目录；
  POSIX 进程组 / Windows 树杀兜底）
→ TS 收到 runtime.ready 后向 Renderer 报告 Chat ready（不依赖 Rust）
→ TS spawn Rust System Runtime → 握手 system.ready → 系统工具可用
→ TS 以 runtime.status 事件第一手上报 systemAvailable
→ Host 从 TS 协议流投影 bootstrap:state 快照给启动页
→ 关闭：Host 发 runtime.shutdown → TS 先 system.shutdown 关停 Rust 再退出；
  超时则 Host 收割整棵进程树
```

Rust 由 TS spawn（ARCHITECTURE §3），Host 不与 Rust 直接通信；`bootstrap_ping` 已移除，
工具健康检查走 `runtime_request('system.ping')` 由 TS 代理。

## 状态

- `starting`：Host 正在启动 TS Runtime；
- `runtime-ready`：TypeScript Runtime 已握手（Chat 可用）；
- `system-ready`：TS 上报 Rust 已握手（工具能力可用）；
- `system-degraded`：Rust 不可用/未就绪/崩溃，不阻塞 Chat；
- `error`：Runtime 无法启动或协议不兼容；
- `stopping`：正在关闭 sidecar。

Rust 崩溃由 TS 按有限退避重启；重启耗尽后保持 degraded，直至 Runtime 重启。

信号语义（POSIX）：宿主安装 SIGTERM/SIGINT 兜底处理器——直接 SIGKILL 整个 TS 进程组后退出；
优雅关停仍走窗口关闭 → `runtime.shutdown` 协议路径。宿主自身被 SIGKILL 强杀时孤儿不可避免
（无法捕获；Windows 后续以 Job Object 覆盖此场景）。
