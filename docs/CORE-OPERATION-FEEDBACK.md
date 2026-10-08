# 核心操作状态与验收

前端核心写操作统一经 `api/client.ts` → `api/operations.ts` → runtime-client。
状态反馈区分等待执行、执行中、刷新中、成功、失败、结果未确认。失败提示不定时消失；同一资源的新操作不会覆盖先前失败提示。

Runtime 为核心写操作保存本次进程生命周期内的请求回执。相同 method / requestId / 参数复用原结果，参数不同则拒绝。Git 的执行状态来自实际工作区队列；前端刷新与写操作分别显示。回执仅保存参数摘要、状态和结果，不另存请求原文。为防止淘汰回执后重复执行，本次启动最多接收 4096 个核心写请求，达到上限拒绝新写请求。

写请求超时不代表取消，前端不自动重试。未确认的请求阻止同一资源再次写入；“检查结果”仅调用 `operation.get`。前端跨重启保存未确认请求的标识与方法，不保存参数或凭据、不回放写入。Runtime 重启后内存回执消失，此时需先核对文件、提交历史或对话，再主动解除保护。当前不承诺跨进程崩溃的持久化 exactly-once。

## 自动验收

`apps/runtime/test/core-acceptance.test.mjs` 在独立临时目录启动真实 Runtime 和 Rust 服务，使用本机模拟 Provider，覆盖首次配置、流式聊天、文件保存与陈旧版本冲突、暂存、提交、重复请求和重启恢复。Rust 二进制缺失时跳过，必须检查测试输出的 skipped 数量。

运行前执行 `pnpm build:packages`，随后在仓库根执行：

```bash
node --disable-warning=ExperimentalWarning --import ./apps/runtime/test/set-test-data-dir.mjs --test apps/runtime/test/core-acceptance.test.mjs
```

操作回执和前端测试另覆盖并发重复请求、实际 Git 排队、超时保护、只读结果检查与重启后的未确认状态。

## 本次验证范围

macOS 进程级核心流程已通过，前端与 Runtime 回归、Rust 测试及安装包构建已执行。完整桌面点击验收由用户执行；Windows / Linux 真机与空闲性能采样尚未完成，不能据此宣称全平台验收通过。桌面验收应覆盖首次配置、聊天、编辑并保存、暂存、提交、重启后数据一致，以及错误提示和未确认结果核对。
