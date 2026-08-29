# apps/desktop

Tauri 桌面宿主。`frontend/` 是 WebView 启动页（Vite + TypeScript），`src-tauri/` 是 Rust Host：创建窗口、注册白名单 command/event，并启动和监控 TypeScript Runtime 与 Rust System Runtime 两个 sidecar（JSON-RPC 2.0 over newline-delimited stdio，stdout 只传协议、stderr 只写日志）。

当前为 M0 Bootstrap：只有启动界面、状态握手与优雅关闭，不含真实 Chat。职责边界与约束见根目录 `ARCHITECTURE.md` 及 `docs/M0-BOOTSTRAP.md`。

常用命令：

```bash
pnpm build:packages && pnpm dev   # 构建依赖后启动桌面应用（开发模式）
pnpm build:desktop                # 构建桌面应用（release 编译，暂不打包安装器）
pnpm --filter @reflexion-os-studio/desktop typecheck
```

说明：Rust sidecar 查找顺序为 `REFLEXION_SYSTEM_RUNTIME` 环境变量、`target/debug|release/reflexion-system-runtime`、`crates/target/debug|release/reflexion-system-runtime`；TypeScript Runtime 通过系统 `node` 运行 `apps/runtime/dist/index.js`。生产安装包（图标、签名、sidecar 资源打包）属于后续阶段，当前 `tauri build` 仅编译宿主二进制。
