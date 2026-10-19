# 全仓库代码与设计审查（2026-10-19）

初始审查基线：`581b9d5`。初始审查阶段只新增本报告；随后用户授权的生产代码修复与验证见文末。

## 范围与方法

对前端、Runtime、agent-core、contracts、runtime-client、Rust 宿主、Rust system-runtime、构建脚本与 CI 建立了清单。扫描覆盖 877 个 TS/TSX/Rust/MJS 文件、110950 行（含所扫描目录内的测试和脚本，排除依赖、dist、target 和生成目录）。这些数字是清单扫描规模，不代表每行都进行了人工审阅。

深入追踪了权限与文件访问、system IPC、进程监管、操作回执、上下文构建、工具调度、消息与会话恢复、资产与备份、MCP、插件安装、浏览器宿主来源检查、终端接线，以及安装包/CI 的主要路径。协议、Agent 生命周期和文件服务是本次重点。

结论区分：

- **隔离复现**：使用临时目录和模拟 sidecar，实际观察到了错误行为。
- **静态确认**：从完整相关调用链确认实现行为，尚未做对应平台或负载的端到端复现。
- **设计建议**：改进方向，不等同于已经发生的数据损坏。

未读取实际凭据、用户浏览器数据或现有 Runtime 数据目录；安全问题仅检查源代码。

## 已确认问题

### F1 · P1 · 敏感拒读策略没有覆盖直接读取与所有 Shell 后端

证据：

- `apps/runtime/src/agent/permissions/presets.ts:20`：默认档位自动允许 `file.read`；`decisionFor` 没有针对敏感文件路径的拒绝分支。
- `apps/runtime/src/agent/tools/files-query.ts` 的 `createFileReadTool` 将路径直接送往系统服务。
- `crates/system-runtime/src/handlers.rs:58` → `filesystem/read.rs` → `filesystem/paths.rs` 只校验工作区 containment，没有执行同搜索使用的敏感文件规则。
- `filesystem/walk.rs:159` 的敏感排除属于搜索遍历，不能覆盖直接按路径读取。
- `sandbox/macos.rs:82`、`sandbox/linux.rs:62` 的 Shell 拒读/遮蔽清单只包含 Runtime 数据目录和少数 HOME 子目录，与 `AGENTS.md` 的拒读清单不一致。

影响：知道工作区内敏感文件的名字即可通过直接读取链绕过搜索排除；Shell 的“执行获批”也不能保证所有禁止读取的对象已被 OS 隔离。提示词中的禁止规则无法代替这一执行边界。

状态：静态确认，未读取任何实际敏感文件，也未执行凭据读取命令。

建议：建立拒读策略的共同定义及跨 TS/Rust 的一致性用例；在 Rust 的直接文本/二进制读取和相关 IO 入口对请求路径、解析后的目标执行检查。Shell 后端需要明确可强制的能力矩阵，不能把部分路径遮蔽描述为完整拒读保证。测试使用合成策略输入或普通临时文件，不依赖真实凭据。

### F2 · P1 · system 请求超时丢弃结果，底层操作仍可能生效

证据：`apps/runtime/src/system.ts:113` 的超时回调仅删除 pending 并 reject；向 Rust 发 `system.cancel` 的逻辑只在 AbortSignal 分支。超时路径还没有清除 abort 监听。

隔离复现结果：

```text
超时返回：system request timeout: review.write
调用失败之后模拟写入完成：true
发送的 cancel 通知：0
超时后仍残留的 abort 监听：1
```

进一步影响：`agent/tools/shared.ts` 将这类异常转成普通工具失败，没有把结果不明的写入标成 `replayUnsafe`；上层锁、UI 和恢复判断可能已经向前推进。UI 操作回执已有 `uncertain`，但底层执行与模型工具的语义并未统一。

建议：将超时、请求取消、底层取消确认、结果不明拆开表达；超时先清理监听，并为有副作用操作保留可查询的执行结果或明确的 uncertain 状态。底层没有确认停止前，不应把它当作安全失败后可重放。Rust 当前 cancel 只处理 Shell，文件操作的取消能力也需要一起设计。

### F3 · P2 · 握手成功即清空预算，使持续崩溃绕过有限重启

证据：

- `apps/runtime/src/system.ts:288` 在收到合法 ready 后立即把 `restarts` 清零。
- 同文件 `onUnexpectedExit` 使用这个计数判断 `MAX_RESTARTS = 3`。
- `apps/desktop/src-tauri/src/supervisor.rs:130` 对 TS Runtime 也采用 ready 即清零的方式，存在同类设计问题。

隔离复现：让模拟 sidecar 每次 ready 后 20ms 退出，已经观察到 5 次成功握手、4 次重启，日志每次仍是 `attempt 1/3`。复现随后主动关闭，没有无限运行。

影响：能够启动、但运行后必然崩溃的进程不会进入稳定降级；可能持续重建终端/浏览器相关状态、打印日志和消耗资源。

建议：采用滚动时间窗预算，或只有连续健康运行达到阈值后才重置失败计数；TS 和 Rust 两层监管使用一致规则。用“多次 ready 后立刻崩溃”的测试补足现有“启动前崩溃”的覆盖。

### F4 · P2 · 分页读取仍扫描整文件，单行缓冲不受返回体上限保护

证据：`crates/system-runtime/src/filesystem/read.rs:63` 使用 `read_until` 将整行读入 Vec；超过窗口或早于 offset 时继续循环，并继续做完整 SHA-256。`MAX_READ_BYTES` 检查发生在整行读取之后，且只检查选中的行。

影响：

- 读取一小段也会扫描整个文件以生成 revision 和 totalLines。
- 超长单行会先分配完整行内存，再判断是否超限；跳过的行不受 selected_bytes 限制。
- `main.rs:245` 同步调用文件 handler，期间不能处理新的请求及取消通知。大文件/慢盘会拖住其他工作区、文件和终端控制请求；TS 的多工具并发不会让这些文件 handler 并行执行。

状态：静态确认；没有进行大内存压力或 OOM 实验。

建议：先使单行扫描内存有界，加入处理字节/时间预算及可取消检查。完整 revision 的计算需要保留正确性，可以在有界 worker 中计算；需要复用时按经过验证的文件身份和版本缓存，不能单靠 mtime。文件任务离开 IPC 读循环时，同时保留按真实资源互斥的写入和全局副作用屏障。

### F5 · P2 · 操作回执达到 4096 条后，整个启动周期拒绝新的核心操作

证据：`apps/runtime/src/operations/registry.ts:69`。已终态回执和其 resolved Promise 都一直保存在 Map 中；容量达到 4096 后直接拒绝新请求。

隔离复现：前 4096 个不同 requestId 完成，第 4097 个被拒，错误要求重启应用。`contracts/src/operations.ts` 表明该限制覆盖发送消息、保存文件、创建会话及 Git 操作等，而非单一低频管理功能。

影响：长期运行或频繁保存时，正常功能会因历史成功操作数量而整体停用。简单删除旧条目又可能使同一个 requestId 被重新执行，因此不能仅换成无条件 LRU。

建议：区分运行中、结果不明和已完成回执；保留去重所需的轻量 tombstone/结果索引，将大结果与去重身份分开管理，并明确可查询和可重放的生命周期。若保证需要跨进程延续，应落库；不要靠重启解决容量问题。

### F6 · P2 · checkpoint 命中前仍全量重建历史，存在同步 N+1 查询

证据：

- `agent/context/context.ts:114` 在检查 checkpoint 之前调用全量 Frame 重建。
- `agent/context/context-frames.ts:36` 读取整个 Session 的非 superseded 消息。
- 同文件 `:63` 对每条有效 assistant 消息再调用一次 `toolCalls.listByMessage`。
- `context.ts:145` 对 checkpoint 水位之前的稳定前缀重新计算 sourceHash。

影响：checkpoint 减少了发送给模型的上下文，却没有使本地启动开销随有效上下文大小有界。每次 Run 启动仍随完整历史增长，并执行大量同步 SQLite/JSON 处理；长会话更容易出现首字前等待，也会占用同一个 Runtime 的事件循环。

状态：静态确认，未针对真实用户长会话进行延迟压测，因此不把它归因为过去某次一小时任务的确定原因。

建议：先消除每条 assistant 的单独查询，按会话或水位批量读取 ToolCall。随后设计消息/会话修订号和 checkpoint 失效规则，使有效 checkpoint 可以直接读取水位后的后缀；编辑、supersede、导入等操作必须显式推进版本或失效，不能为了省扫描牺牲历史正确性。

## 设计层面的主要建议

### D1 · 把执行状态做成端到端语义，而非每一层各自超时

现有分层、canonical ToolOutput、revision 校验、精确审批、终态事务和动态委派预算有明确价值。最需要加强的是 TS 调度 → IPC → Rust 执行 → 结果落库之间的一致状态。

建议统一表达 queued、running、cancel requested、cancel confirmed、completed、uncertain；具体命名应继续遵守现有契约，不再平行造一套近似状态。UI/工具的失败判定、资源锁释放和重试保护都消费同一结果。F2/F4 应作为一个边界问题一起设计。

### D2 · CI 的测试入口与实际风险不匹配

当前唯一工作流 `.github/workflows/build-windows.yml` 实际包含三个平台，名称容易误导；它手工枚举部分测试，而非覆盖全部包测试。本次核对发现 `test/execution/*.test.mjs`、`transcript-follow.test.mjs`、`reasoning-preference.test.mjs` 没有进入现有 CI 调用路径。

建议维护一个可在本地和 CI 复用的核心回归集合，至少覆盖权限、取消/超时、结果不明、逐文件批量编辑、启动恢复和滚动跟随。按风险分层执行快速协议/内核测试、浏览器集成、三平台原生验收，不必让每个小改动都重跑完整安装包。

CI Rust 缓存还没有包含 `apps/desktop/src-tauri/target`。这可以解释宿主依赖反复冷编译的一部分开销；不能仅凭配置估算具体节省时间。缓存应按平台、架构、Cargo.lock、工具链和原生依赖版本正确分键，再实测命中率与编译时长。

### D3 · 架构文档和退役功能的边界需要收敛

`ARCHITECTURE.md` 开头已经说明 Workflow 退役，但第 4 节仍描述 Graph Runner 作为统一执行内核。Store 仍装配 Workflow 的定义、生成、执行、输出、确认和恢复对象，部分项目/会话删除前置条件也依赖这些对象。

保留旧表和历史兼容有合理性；问题是当前职责没有在文档中清楚地区分“活跃执行”和“历史兼容”。建议更新架构主线，将历史兼容接口收敛为受限边界，并为旧库恢复/删除保留回归，避免未来维护者把旧 Graph 设计重新接回活跃业务。不要在审查修复中破坏性删除历史表。

## 优先顺序

1. F1：补齐不能由审批或提示词放宽的拒读边界。
2. F2 + F3：先收敛结果不明、取消与崩溃循环。
3. F4 + F6：针对文件和上下文构建做有界处理，测量真实长文件/长会话负载。
4. F5：设计可持续使用的操作回执生命周期。
5. D2 + D3：同步回归门禁、构建缓存和架构说明。

## 验证与限制

本轮已完成：

- Runtime TypeScript 构建。
- 全仓库 lint、根 TypeScript 检查、桌面前端 TypeScript 检查。
- agent-core + runtime-client：112 项测试通过。
- 选定 Runtime 执行、system client、操作、上下文、审批、动态权限、Provider 协议/重试/超时：96 项测试通过。
- Rust 文件服务：72 项测试通过（其余 165 项被过滤，不代表失败或已经验证）。
- 前端模型恢复、消息滚动、历史分页和打包路径：22 项测试通过。
- 以上测试共 302 项通过；该数量不包含本轮刻意复现的 3 组错误行为。
- 3 组隔离复现：超时后的延迟副作用与监听残留、ready 后连续崩溃突破重启上限、操作回执容量耗尽。

现有测试通过与上述问题同时成立，说明仍缺少对应边界的回归，而非说明测试无价值。

没有执行完整 `pnpm test`、全套 Rust 测试、三平台安装包或 Windows/Linux 真机验收；没有调用真实模型、读取实际机密或压测到 OOM。浏览器/CEF、MCP 和插件的外部依赖及平台分支只完成源码重点审查，本报告不能视为完整安全认证或逐行证明。

## 六项问题的修复跟踪

- **F1**：拒读规则集中为 contracts 的公共 JSON 数据源，TS 校验并复用，Rust 编译嵌入。路径解析检查原始目标和解析目标，搜索与 Shell 名称正则复用策略。macOS 的固定敏感根和大小写兼容正则已通过 Seatbelt 真机回归。按用户后续明确要求，撤销新增的 Linux/Windows Shell 整体禁用和无沙箱拒绝；恢复既有审批后执行流程，保留原有沙箱能力检查。审批不等同于操作系统完整拒读保证，Windows/Linux 仍待真机验收。
- **F2**：超时发送取消、清理 abort 监听，返回 `operation_uncertain`。单项和批量工具传播 `replayUnsafe`；Rust 可取消排队文件请求，流式读取在块边界检查取消。已经进入原子写入的操作仍可能完成，取消不代表副作用回滚，禁止自动重放不明结果。
- **F3**：TS 与 Host 改为连续运行至少 60 秒才重置重启预算。新的 ready 后连续崩溃回归在第三次重启后稳定降级。
- **F4**：有界 FIFO 文件执行器使 IPC 主循环继续处理取消；读取段最多并发 4 项，变更独占并形成屏障，排队上限 64 项。扫描最多 64MiB，返回窗口最多 2MiB，长行分块处理；不对超限文件伪造 revision。
- **F5**：schema v53 增加 SQLite 轻量操作回执，最近 256 个结果在内存保留；淘汰后的旧 requestId 不重新执行，重启将未定回执收敛为 uncertain。5000 次操作和重启后的去重回归均通过，参数和完整结果不写入回执表。
- **F6**：工具记录批量读取；有效 checkpoint 直接取水位后缀；数据库触发器对消息和工具记录的前缀变更使缓存失效，迟到摘要再次校验来源。迁移保留 canonical 历史，只清理可重建的旧 checkpoint。

修复后验证：

- 格式、lint、根级和前端 TypeScript 检查通过；Rust 格式和 Tauri 宿主检查通过。
- 工作区 packages 构建通过。contracts 83 项、agent-core 84 项、runtime-client 28 项、Rust 240 项、桌面 96 项测试通过。
- 完整 Runtime 套件 1033 项通过、17 项按现有显式条件跳过；随后新增的批量不明结果保护与 v52 迁移用例及操作回执的存储故障用例，共 19 项定向通过。
- 完整套件暴露了两处旧测试夹具问题，分别补齐请求预算测试的 Run 状态，以及让附件浏览器测试使用与桌面一致的安全上下文；相应用例和完整桌面套件已通过。
- 自包含 macOS debug `.app` 打包及嵌入前端检查通过。用户正在运行仓库内 release `.app`，因此使用独立 debug 输出，没有覆盖该运行中版本；未构建 release DMG 或 Windows/Linux 安装包。
- 使用独立应用标识和数据目录的 dev 实例完成启动及四轮空闲采样：宿主、WebView、CEF helpers、Node 与系统 sidecar 均为 0.0% CPU。top 的内存样本约为宿主 68MiB、WebView 151MiB、Node 53MiB、系统 sidecar 2MiB，短时采样中稳定；不据此推断真实长负载表现。

新增核心可靠性与执行回归已纳入三平台 CI。Windows/Linux 的直接文件工具复用同一 Rust 边界，但未在本机冒充跨平台真机验收。

### 提交前复核（恢复 Shell 审批流程后）

继续复核当前未提交修复，未发现新增的需修复问题。格式、lint、根级与前端类型检查、packages 构建、Tauri 宿主检查通过；Rust 240 项通过；完整 Runtime 1036 项通过、17 项按既有条件跳过；Shell 审批、提权与一次授权防重放的 28 项定向回归通过。Windows/Linux 未进行真机验证，不据此声称跨平台完成。
