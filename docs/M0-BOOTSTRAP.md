# M0 Bootstrap

M0 是当前唯一实现范围：启动界面、两个 sidecar 的生命周期和最小状态握手。它不实现真实 Chat、数据库、工具或审批。

## 状态

- `starting`：Host 正在启动 sidecar；
- `runtime-ready`：TypeScript Runtime 已握手，Chat Core 仍待实现；
- `system-ready`：Rust Bootstrap 已握手；
- `system-degraded`：Rust 不可用，但不阻塞 Runtime；
- `error`：Runtime 无法启动或协议不兼容；
- `stopping`：正在关闭 sidecar。

## 完成标准

```text
Tauri Host 启动
→ 启动 Rust 和 TypeScript sidecar
→ 收到 system.ready/runtime.ready
→ 启动页显示状态
→ 可执行 ping/status
→ 关闭时发送 shutdown 并回收进程
```

M0 通过后才进入 1A-1 Chat Core。完整目标架构中的 Graph、Plugin、Memory、Skill、Multi-Agent、Workspace、Asset、Browser、Approval、OS Sandbox 和 Multimodal 均为 Future/Post-MVP。
