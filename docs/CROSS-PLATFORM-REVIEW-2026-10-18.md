# 跨平台与 GitHub Actions 审查（2026-10-18）

## 结论边界

修复前存在可明确定位的 Windows 安装冒烟误判，以及功能分支/PR、Linux 没有被 CI 覆盖的问题。修复后在本机完成静态检查、回归和目标编译检查；尚未推送或触发远程 Actions，因此不宣称三个 runner 已全部成功。

## 修复

| 优先级 | 问题与证据                                                                                                                                                               | 处理                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | Windows 安装冒烟把“根目录只有一个非卸载 EXE”作为启动前提。CEF 资源会额外携带 bootstrap 等 EXE，导致脚本在真正启动宿主之前抛出 `Installed desktop executable not found`。 | 精确定位并检查 `reflexion-desktop.exe`，不按 EXE 总数猜测宿主。                                                                           |
| P2     | CEF 的 Windows `RunWinMain` 导出只有四个参数，命令行按字节指针声明，与官方入口的五参数及 UTF-16 命令行不一致。                                                           | 补充不解引用的版本信息指针，并使用 UTF-16 指针。未将此差异认定为已复现的 Windows 崩溃。                                                   |
| P2     | 工作流只监听 main/master push 与版本 tag，没有 PR 事件；矩阵只有 Windows/macOS，Linux 安装与上传步骤永远不运行。                                                         | 加入分支 push、面向 main/master 的 PR，以及 Ubuntu 22.04 构建/打包任务。Linux 继续使用明确的系统浏览器 fallback，不宣称已有 CEF Surface。 |
| P2     | 新 UI fixture 的 ProjectFiles stub 只匹配 `/` 路径分隔符，Windows 下不能可靠隔离真实文件模块。                                                                           | 同时匹配 `/` 与 `\\`；将 product-ui 与 model-selection 回归加入三平台 CI。                                                                |
| P2     | 上轮隐藏了不支持思考强度时的控件，用户无法区分“不支持”与“功能消失”。                                                                                                     | 恢复入口；不支持时禁用并显示说明。补测可配置、禁用、加载中与加载失败四种状态，不擅自把模型标记为支持。                                    |

工作流新增 format/lint/typecheck 与完整路径边界测试；增加 `.gitattributes` 固定文本 LF，避免 Windows checkout 换行差异导致格式检查误报。AppImage 构建允许自解压运行，避免依赖 runner 挂载 FUSE。

CEF 入口依据：[官方 Windows 示例](https://github.com/chromiumembedded/cef/blob/master/tests/cefsimple/cefsimple_win.cc)、[沙箱与 bootstrap 说明](https://github.com/chromiumembedded/cef/blob/master/docs/sandbox_setup.md)。事件规则依据：[GitHub 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)。

## 验证

- Workflow YAML 可解析，矩阵为 linux/windows/macos，所有引用的脚本和测试文件存在。
- Rust System Runtime：`cargo check --target x86_64-pc-windows-msvc` 与 `--target x86_64-unknown-linux-gnu` 均通过。这不包含链接、执行或桌面宿主的原生依赖验收。
- 本机 macOS 宿主 cargo check 与浏览器域测试（30 项）通过；两个 Rust workspace 的格式检查通过。
- UI 与模型选择定向测试 5 项通过；format、lint、根与桌面 typecheck 通过。

- `pnpm test` 全流程通过：脚本 11、contracts 82、agent-core 72、runtime-client 28、Runtime 751、桌面前端 85、Rust System Runtime 237 项通过。Runtime 的 4 项 Windows 专属测试在本机按平台跳过。
- System/Chat/Workspace/Skills/迁移冒烟、终端故障矩阵（26/26）、白名单一致性均通过。
- `pnpm build:desktop` 通过，生成本轮源码对应的自包含 macOS 应用与 ARM64 DMG。

## 推送后的判定

推送包含工作流修改的分支即可触发三个构建任务，PR 面向 main/master 时也会触发；工作流没有创建 GitHub Release 或自动发布产品的步骤。应以三个任务最终的构建、安装冒烟与 artifact 上传结果作为 CI 是否成功的依据。

本机缺少 Windows/Linux 桌面系统库与执行环境，无法代替 MSVC/CEF 加载、NSIS 安装、Linux WebKitGTK 与 AppImage 的实际 runner 结果；未执行远程推送或真实 Actions 运行。
