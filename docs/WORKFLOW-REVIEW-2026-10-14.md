# Workflow W4–W5 Review 与验证记录

> 历史文档：2026-10-14 已退役独立 Workflow 编排。实现保留于 `codex/archive-workflow-2026-10-14`，当前方向见 [Agent 协作](AGENT-COLLABORATION-2026-10-14.md)。

日期：2026-10-14；分支：`feature/workflow`。W0–W3 已提交为 `f84d08b`。
本记录针对后续本地实现，不涉及远程 PR 或多媒体/定时任务。

## 审查与修复

| 问题                           | 影响                                  | 修复与验证                                                                        |
| ------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------- |
| 版本保存与草稿关联分两次请求   | 中断或并发修改后草稿仍指向旧版本      | 同事务写入版本、CAS 更新草稿和 requestId 结果；故障注入验证整体回滚               |
| 候选仅绑定草稿版本             | 另一窗口修改候选后可能应用未审阅内容  | 编辑/应用均比较候选 stateVersion；旧版本应用和重复请求回归通过                    |
| 快速点击与迟到响应             | 重复提交、覆盖新编辑或倒退状态        | 同步工作锁、编辑 epoch、选择身份和单调状态版本检查                                |
| 只读画布仍有交互切换           | 用户可能拖动快照并写入编辑草稿        | 只读关闭交互切换；拖动/连接/删除回调再检查只读状态                                |
| 删除节点与连线分开回调         | 后一回调可能恢复已删节点              | 单个 onDelete 同步删除全部引用；保存版本对象不被原地修改                          |
| 草稿已保存但版本未更新         | 运行可能使用用户以为已保存的新图      | 运行仅允许编辑定义与已保存版本完全一致；GUI 验证应用新节点后运行禁用              |
| 编辑中的 JSON 与外部新配置不同 | 高级配置可能覆盖刚改过的 Prompt/布局  | 明确应用，基线冲突拒绝覆盖，可放弃 JSON 编辑并刷新                                |
| 并行列表响应乱序               | 状态摘要可能倒退                      | 列表与详情均保留更高 stateVersion；事件有界合并，无空闲轮询                       |
| 图适配默认最低缩放过高         | 复杂图/候选预览被裁切，单节点过度放大 | 最低缩放 0.05，测量完成/拓扑改变后一次 fit；六节点 GUI 验证                       |
| 端口改名不触发尺寸变化         | React Flow 的端口索引可能陈旧         | 端口 key 变化显式刷新 node internals；稳定 callback 与 primitive 依赖，无常驻动画 |
| 原始节点 ID 用于 CSS 选择器    | 引号/控制字符可能破坏库内选择器       | 画布只使用 UTF-16 十六进制展示 ID，操作映射回原 ID，不改定义/成果身份             |
| 端口 JSON 夹带其它节点字段     | 可能意外改动 Prompt 或权限            | 从契约派生严格的 inputs/outputs 子 schema；headless UI 回归确认拒绝其它字段       |
| 候选异步保存失败后清空编辑     | 用户修正内容可能丢失                  | 等待保存结果，失败保留文本与编辑态；headless UI 回归确认                          |
| JSON Schema 对象键顺序比较     | 等价端口无法连线                      | Runtime/前端复用同一 canonicalJson；仅等价搬移，原持久化指纹语义不变              |
| 生成途中配置变化/未知工具请求  | 修正可能改用新配置或模型尝试工具      | 同次生成冻结模型采样配置；空工具表，任何工具批次直接拒绝；真实 Run 回归通过       |
| 重启或切换页面                 | 候选丢失、隐式重发、草稿被覆盖        | 草稿/生成审计落库，生成启动恢复为 interrupted，不重发；页面/项目切换保留编辑态    |

## 实施范围与边界

React Flow 管理与编辑页、角色模板/Prompt/任务/模型/预算配置、流程高级 JSON 编辑，
独立草稿及不可变定义版本；运行快照、历史、工具审批、业务验收、节点轨迹、成果、
资源打开、取消及显式恢复/重试。

自然语言支持完整新图和添加一个新节点。新增角色由 Prompt 内嵌，不自动注册全局模板。
自动生成默认只读、继承运行模型；用户可在候选/节点配置中显式编辑。单节点请求只带
现有端口摘要，不带已有 Prompt 或工作区内容。生成使用普通隔离 Run，禁用所有工具/
task；初次加最多两次修正共享 32000 token/120 秒预算，并行生成最多两个。
生成、候选编辑、草稿应用、版本保存、执行是独立控制动作；来源由服务端记录并保留。

新存储为 schema v46 的 workflow_drafts/workflow_generations，项目删除级联审计数据；
活动生成也阻止项目删除，内部生成会话不进入普通 Chat 或独立重发/删除链路。
新能力均沿 contracts → runtime-client → Runtime → 生成的 Host 白名单；无新增 OS 依赖。
macOS/Windows/Linux 使用同一 React/Radix/React Flow、Node SQLite 与 JSON-RPC 路径；
实际工具和文件授权继续交给已有三平台 Runtime/System 适配，未新增 POSIX 产品逻辑。

## GUI 与空闲验证

独立临时项目 + 本机合成 SSE Provider，仅使用合成测试密钥。为准确绑定界面窗口，
用独立临时 .app 包装同一 debug 二进制，前端仍连接 Vite localhost:5173。
首次 GUI 工具被锁屏阻挡，后续恢复并完成以下验收：

- 作家 → 编辑者：候选 ready 时草稿未替换、定义未保存；分别应用、保存 v1、运行，
  两节点 succeeded，40 tokens，最终成果显示。
- Builder 六节点：PM、设计师、测试计划、开发者、测试者、人工验收；五个 Agent
  完成后 waiting_user，展示结构化 verdict，点击验收后 succeeded，6 attempts/100 tokens。
- 在写作 v1 添加语言润色者：候选保留旧两节点并新增连线；应用后运行禁用，保存 v2
  后三节点 succeeded，60 tokens，显示 text/polished 两项成果；节点轨迹可独立查询。
- GUI 发现的草稿下拉标签与复杂图缩放问题当场修复；只读快照无交互切换按钮。

这些是接线和确定性状态验收，不证明真实模型的规划/代码/写作质量。未使用用户项目、
真实 Provider、浏览器登录态或媒体模型。

空闲四轮 top：Runtime 0.0%；Host 0.0–0.1%；Renderer 0.0–0.7%，未见持续空转。
ps RSS：Host 82.67 MiB、Runtime 45.52 MiB、Renderer 137.19 MiB。此前 W0–W3 同方法
CPU 为 0.0%；本次接近空闲。系统压力/数据/缓存不同，RSS 变化不归因于本次实现。
采样期间不构建或修改 Renderer。临时数据及原始采样路径：
`/var/folders/0z/dpnv__6j40s_0cm9bkp5xzpw0000gn/T/reflexion-workflow-gui-cCm1ik`。
已关联 Host 51797、Runtime 51829、Renderer 51825；结束后全部退出，Rust sidecar、
合成 Provider 与误启动的本地旧打包窗口也已关闭，没有遗留测试进程。

## 最终验证

全量回归：scripts 11、Contracts 81、Agent Core 65、Runtime Client 25、Runtime
589 pass / 4 平台 skip、前端 86、System Runtime 233。Workflow 相关 72 项：
Contracts 6、Runtime 61、前端 5。Host 默认测试 41；白名单、协议/Chat/迁移等冒烟和
终端故障矩阵 26/26 通过。format/lint、根/前端 typecheck、build:packages、两个 Rust
workspace 格式检查、Host cargo check 与 macOS app/DMG 构建通过。

完整日志分别为 `/tmp/reflexion-workflow-w45-final-tests.log`、
`/tmp/reflexion-workflow-w45-host-tests.log` 与 `/tmp/reflexion-workflow-w45-desktop-build.log`。
最后端口显示/索引修正及 JSON 编辑回归另跑前端检查、测试与构建，不改变 Runtime 行为；其再次 GUI 复验受锁屏阻挡，未将这次未完成的复验计为通过。

跳过：Windows/Linux 真机、完整窄窗口/高 DPI/长选项矩阵、真实模型质量和长稳。
后续阶段仍为媒体生成、调度与硬化；本次未提前扩展到这些阶段。

独立无登录态 headless Chromium 组件回归验证：异步失败保留 JSON、基线冲突、端口配置字段限制、任意旧 ID（引号/反斜杠/孤立代理项）、只读删除防护与端口改名后连线刷新。它补充组件层证据，不替代未完成的最终 Tauri GUI 复验。
