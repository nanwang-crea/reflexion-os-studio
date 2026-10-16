# 安装包前端资源验收

2026-10-16 实际安装包窗口出现 `asset not found: index.html`。磁盘上 dist-frontend/index.html 存在，但发布二进制依赖列表没有前端文件；仅检查 Vite 构建和打包命令返回成功不足以证明安装包可启动。

build:packages 与 build:desktop 均会执行 Vite 并重建同一 dist-frontend，禁止并行运行。Rust generate_context 在该目录被清理时可能嵌入空资源集；前端构建、Rust 编译和安装包验证必须依次完成。

Tauri beforeBundleCommand 在生成各平台安装包前运行编译后二进制的 --verify-frontend-assets，验证二进制内的 index.html 及引用的入口 JS/CSS 存在且非空。此模式不启动窗口、sidecar 或用户数据服务，失败时中断打包；检查的是嵌入资源，不是磁盘上碰巧存在的文件。macOS、Windows、Linux 均在本机生成对应二进制后执行，不宣称跨平台真机完成。

最终验收还必须真实启动 APP：确认主页面加载、角色页可进入，再检查退出后无孤儿进程。不能用 Chromium 中的组件 fixture 或 `cargo check` 替代 WebView 启动冒烟。
