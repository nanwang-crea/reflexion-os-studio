# UI 调整与代码审查（2026-10-17）

## 范围与方法

本轮在保留现有功能边界的基础上调整视觉。代码盘点覆盖桌面前端、Tauri 宿主、TypeScript Runtime、contracts、agent-core、runtime-client 与 Rust System Runtime，生产代码约 11 万行。人工审查重点是跨进程传输、Run 防重复执行、审批、资产与文件边界、CEF 生命周期和前端订阅；结合全仓静态检查、构建与回归测试。此记录不代表全部代码逐行审计，也不代表 Windows/Linux 真机验收完成。

## 已确认并修复

1. **LoopGuard 的旧拦截状态跨 freshness epoch 生效。** 一次成功变更被重复拦截后，即使用户新消息或其他成功变更推进环境，仍可能收到 `no_progress`。现在仅在成功调用绑定的当前 epoch 内使用该拦截状态。增加用户推进 epoch 与其他变更推进 epoch 两个回归场景。
2. **RuntimeTransport 异步 attach 存在重复订阅与释放竞态。** 并发 attach 共享一个 Promise；dispose 推进订阅代际，迟到的监听立即释放，旧代际回调不再处理消息。增加并发接线、接线过程中 dispose，以及重新接线后拒绝旧订阅响应三个回归场景。
3. **Rust 路径解析把失效符号链接当成未创建的普通路径。** `Path::exists` 跟随链接，无法区分这两种情况。改用 `symlink_metadata` 检测目录项，链接仍交由 canonicalize 验证；失效链接与权限错误均拒绝。新增叶子链接和中间目录链接测试。实现使用跨平台标准库；创建符号链接的回归在 Unix 执行，Windows 真机仍待验证。这是解析边界缺口，不将其夸大为已证实的越界写入。

4. **开发模式无法确定启动二进制。** CEF helper 引入第二个 Cargo binary 后，Tauri dev 调用的 `cargo run` 没有默认目标，启动直接失败。给桌面 package 设置 `default-run = "reflexion-desktop"`；隔离数据目录与应用标识的原生开发实例已实际启动并达到 `system-ready`。

## UI

- 统一蓝灰背景、青绿色强调色、侧栏选中状态和焦点样式；浅色与深色分别设置文本及表面层级。
- 调整落地页标题、说明与输入区间距；输入区控制项允许换行，发送/停止动作保持在右侧独立列。
- 不展示模型不支持的思考等级控件；加载和错误状态仍可见。
- 右侧 Surface 标签样式归共享组件，避免依赖浏览器模块样式的加载顺序。
- 聊天和工作区大型 CSS 按消息、运行、工具轨迹、文件、Git、预览等职责拆分，入口保留有序 imports。
- 新增真实组件组成的隔离 UI fixture：两种主题、1440/940px 分栏、输入区不横向溢出、动作位置、模型下拉 Escape 焦点恢复、设置主题切换。不连接真实 Provider，不读取用户数据。

## 验证

- `pnpm test` 全流程通过：脚本 11、contracts 82、agent-core 72、runtime-client 27、Runtime 751、桌面前端 85、Rust System Runtime 237 项通过；Runtime 的 4 项 Windows 专属测试按平台跳过。
- 随后新增旧订阅回调回归，runtime-client 最终 28 项通过；最终配色的 UI fixture 再次通过。
- System/Chat/Workspace/Skills/迁移冒烟、白名单一致性与终端故障矩阵（26/26）通过。
- 格式检查、ESLint、根/桌面 TypeScript 检查、packages 构建、两个 Rust workspace 的格式检查、宿主 cargo check 通过。
- 宿主默认 CEF 测试 45 项、无默认 feature 测试 31 项通过。无 CEF 构建保留既有 dead-code 警告。
- `pnpm build:desktop` 完成自包含 macOS 应用与 ARM64 DMG；已核实最终 CSS 包含加深后的浅色辅助文字色值。
- 修复默认启动项后实际运行 Tauri dev：宿主、Runtime 与 System Runtime 达到 ready。按 `top -l 4 -s 3` 采样，后三次这三个进程均为 0.0% CPU。

截图由隔离 fixture 生成，不替代 macOS 原生 CEF 或 Windows/Linux WebView 真机验收。原生 UI 工具报告 Mac 锁定，无法继续点击与关闭验收；本轮尚未重新进行原生 CEF 关闭循环、真实模型长稳。资源采样发生在锁屏状态，未覆盖 WebView 渲染进程，也没有同方法的变更前基线，因此不能据此宣称性能验收完成。

## 下一步顺序

1. **先完成现有能力的验收闭环。** CEF 点击、焦点、关闭与退出循环，以及 Windows/Linux Browser/Terminal/权限沙箱矩阵；平台差异保持显式，不能以 macOS 测试代替。
2. **真实模型端到端验收。** 覆盖工具审批、取消/重试、发送队列、动态委派预算与恢复、长上下文和长时间运行；用已有契约与测试流程收敛问题。
3. **再选下一项产品能力。** 根据上述结果决定 Browser 后续交互或 Provider/Tool 插件等现有路线图事项。检索式记忆仍按约定直接引入 mem0；本轮不提前实现登录、许可、多模态或自研召回管线。
