# ZCode 上下文压缩与历史组装对比审计

日期：2026-10-19。范围：历史重建、请求预算、摘要、轮内压缩、恢复与诊断。本文记录审计结果和建议，未修改生产代码。

后续落实：本文正文保留 `0619912` 时的审计快照；四项正确性问题已在后续工作区变更中修复，具体行为与验证记录见 [Context Management](CONTEXT-MANAGEMENT.md#摘要正确性修复2026-10-19)。预算按用户意见区分软压缩预算和模型窗口，不因单纯超出软预算而拒绝发送。

## 对比基线与证据

- ReflexionOS Studio：`0619912`，当前工作区源码与已构建 Runtime。
- ZCode：本地相邻仓库 `../ZCode`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，提交说明 `feat: update v3.14.3`，提交日期 2026-09-24。结论限定于该版本，未把网上较新版本的宣传视为实现证据。
- ZCode 官方仓库：[zai-org/ZCode](https://github.com/zai-org/ZCode)。主要证据均直接读取本地源码；网络检索仅用于核实官方仓库和公开文档。
- 四组问题使用纯合成 Frame、内存 Store 替身和 mock fetch 复现，不连接真实模型，不读取实际会话、配置或凭据。
- 现有 Context 回归：`context-checkpoint`、`context-fallback`、`inrun-compaction`、`context-frames` 共 22 项通过。首次有一项被沙箱本地端口限制拦住，获准环境重跑通过。

## 当前能力对照

| 方面       | ReflexionOS Studio                                                                       | ZCode v3.14.3                                                                      | 判断                                                 |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 规范历史   | SQLite Message / ToolOutput → 原子 Frame；工具调用与结果成组校验                         | Runtime entries 带语义、可见性、前缀身份，再投影为 Provider 请求                   | 保留我们的原子帧和事实源                             |
| 会话摘要   | 结构化增量 checkpoint、source hash、水位线、同 hash single-flight                        | 模型摘要、持久化 compact boundary、保留区间与冷恢复                                | 我们已有可继续演进的基础                             |
| 首次超预算 | 发起后台 checkpoint，本次请求立即确定性裁剪                                              | 请求前等待自动摘要，并替换当前活动上下文                                           | 我们优先首字延迟，存在本轮历史丢失风险               |
| 长 Run     | 每步做确定性裁剪；启动时创建的后台 checkpoint 不在同一 Run 内主动装入                    | 每个模型步骤前检查压缩，可在 mid-turn 摘要                                         | 应补轮内语义压缩与安全切换                           |
| 局部清理   | 折叠旧工具整轮；必要时对正文逐步收缩                                                     | microcompact 可按工具分组清理旧结果，保护近期组与默认错误结果                      | 可借鉴策略；该版本 microcompact 默认关闭             |
| 超窗恢复   | `context_limit` 终止循环；HTTP 400 未见同请求压缩恢复路径                                | reactive compact，按模型步骤限次，另有 rapid-refill 保护                           | 应补精确识别和有界恢复                               |
| token 预算 | 文本粗估、工具入参、reasoning/continuation、固定图片估算；tools schema 未进入 Frame 估算 | 本地估算结合有效 provider usage 基线；诊断按 system/skills/tools/MCP/messages 分类 | 应对完整请求统一预算与诊断；ZCode 也并非全量精确计数 |
| 前缀与缓存 | system、指令、记忆、checkpoint 拼成一段；任务状态另放 user control                       | stable/dynamic 与 system/meta_user 分层，有 cache-control 投影                     | 可改善缓存稳定性与来源边界                           |
| 可观察性   | 构建/命中等 stderr 指标，无完整用户压缩生命周期                                          | started/retrying/completed/failed/interrupted、压缩边界与用量记录                  | 应把后台失败、成本和实际覆盖范围做成结构化状态       |

ZCode 源码入口（固定版本）：[循环](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts)、[摘要校验与请求](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts)、[上下文分层](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/context/builder.ts)、[microcompact 配置](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts)。

## P1：优先修复的正确性问题

### 1. 摘要调用没有继承供应商 API 协议

位置：`apps/runtime/src/agent/context/context-checkpoint.ts:293`，`apps/runtime/src/provider.ts:17`。

`summarizeCheckpointFrames` 使用旧的 `streamChatCompletion` 包装，它固定把 `apiFormat` 传为 `undefined`，落到 OpenAI Chat 适配器。即使正常聊天配置了 Anthropic 或 OpenAI Responses，摘要仍请求 `/chat/completions`。只提供原生协议的供应商会在长会话时摘要失败，后续持续依赖裁剪。

复现：分别传入 `anthropic`、`openai-responses`，拦截 fetch，两次实际 URL 均为 `https://audit.invalid/v1/chat/completions`。

建议：摘要统一使用 `streamChat(options, provider.apiFormat, ...)`；显式设置摘要输出预算、超时和重试边界；对三类协议分别做端到端合成测试。摘要模型若允许另配，必须显式展示其供应商与费用归属，不能静默换模型。

### 2. 摘要只看到了部分输入，却把水位线推进到全部历史

位置：`context-checkpoint.ts:90`、`:118`、`:229`、`:235`。

当前 transcript 对用户/助手正文只保留前 400 字符，对工具结果只保留前 200 字符；工具调用只有名称，无参数。最后再对全部片段按顺序取前 12,000 字符。超过限制后，较新的稳定历史会完全不进入摘要请求，但 `sourceHash` 与 `throughMessageId` 仍覆盖整个稳定区间。后续历史组装把这些未被摘要模型看到的内容视为已覆盖。

复现：40 个合成用户 Frame，最后一个 Frame 带约束标记；最终 transcript 恰好 12,000 字符，末尾约束不存在。合成 `file.edit` 的目标路径只存在于 arguments，摘要输入不包含该路径。

原始历史仍保留在 SQLite，但摘要与最近窗口可能都不再向模型提供这段信息。晚出现的用户纠正、文件目标、失败原因尤其容易丢失。

建议：按 token 预算分批处理，覆盖一批才推进一批水位线；显式记录实际覆盖范围与遗漏。用户约束优先保留，工具事实通过 canonical ToolOutput、工具参数中的安全定位字段、退出状态与 ResourceLink 提取。摘要覆盖率必须成为验证条件。不可用先截头、再标记全部覆盖的方式代替覆盖证明。

### 3. 非法摘要被当作成功缓存

位置：`context-checkpoint.ts:36`、`:190`、`:234`；`context.ts:223`。

schema 校验失败时 `sanitizeSummary` 返回全空摘要；`runEnsure` 无条件 upsert 并返回 `failed: false`。下一次同 hash 的请求直接命中这份空摘要。ContextBuilder 又要求摘要非空才允许注入，于是它会反复判断需要刷新，却被服务层的同 hash 命中挡住。旧的有效摘要也可能被新生成的空结果覆盖。

复现：摘要器返回合法 JSON 但 schema 错误的 `{invalid: 'shape'}`；首次返回 `failed: false`，第二次 `hit: true`，摘要器仅调用一次，Store 中已写入空摘要。

ZCode 的 `formatCompactSummaryOrThrow` 会拒绝空摘要或模型工具调用，之后才进入替换/持久化路径。

建议：区分解析失败、schema 失败、过滤后为空与成功；失败保留旧 checkpoint，不能推进水位线。把当前永久同 hash 失败缓存改成有界冷却与明确的手动重试入口，保留并发去重。摘要结果需要验证完成状态，避免把不完整输出当作有效结果。

### 4. 预算未覆盖完整请求，裁剪后也缺少硬性复核

位置：`packages/agent-core/src/context/estimate.ts:5`、`context/bounds.ts:104`；`apps/runtime/src/agent/run/model-turn.ts:119`；`agent/instructions/render.ts:15`。

Frame 估算包含正文、工具参数、reasoning/continuation 和图片估算，但工具定义在估算后才通过 `registry.specs()` 加入请求。大量 MCP schema 可让实际请求明显变大。此外，system、最新用户输入、任务控制块等受保护内容可能已超预算；收缩达到上限或无候选后，函数仍直接返回超预算结果。

复现：预算 1,024 token，system 与最新用户各含 8,000 个 ASCII 字符，`boundFramesForModel` 返回值仍估算为 4,016 token。

四层指令/记忆各自允许 20,000 token，理论上仅这一部分就可达到 80,000 token，高于默认 64,000 的上下文预算。增加四个文件的单文件上限会继续放大问题。

建议：统一计算 system、instructions、memory、skills、tool schemas、MCP schemas、history、task state、images、输出预留与协议余量。历史裁剪后对最终投影再检查；不能容纳受保护内容时明确报可解释的配置/输入过大错误，不能无限裁剪用户硬约束或继续发必然超窗的请求。provider usage 用于校准实际序列化开销，不能把 Run 累计 tokens 当成当前上下文用量。未知模型窗口保留保守默认，已知窗口按实际能力计算，不照抄 ZCode 的固定阈值常量。

## P2：压缩质量与恢复策略

### 5. 让摘要在同一个长 Run 内生效

位置：`apps/runtime/src/agent/context/context.ts:235`；`apps/runtime/src/agent/run/runner.ts:197`；`packages/agent-core/src/loop.ts:93`。

ContextBuilder 仅在 Run 启动时构建历史；后台 checkpoint 不会在这个 Run 后续模型步骤中重新装入。轮内只做同步确定性裁剪，裁剪结果直接替换循环基线。较早的工具事实会变成省略说明，长任务中的后续决策可能缺少依据。

建议：接近软阈值时提前刷新；到硬阈值且缺乏有效摘要时，在工具批次结束后的安全边界等待一次摘要。摘要成功后原子替换工作上下文，并保留当前任务、用户纠正、近期完整工具轮。失败才进入明确可观察的降级。后台任务应按 session/source revision 去重、取消过期工作，摘要费用纳入独立用量归属。

### 6. 增加精确的超窗恢复，保留工具执行边界

位置：`packages/agent-core/src/loop.ts:120`。

目前 `context_limit` 直接停止。HTTP context-length 拒绝未发现进入同一步骤压缩恢复的实现。ZCode 在同一个 model step 内有 reactive compact 的一次性保护，并限制压缩后快速再次塞满的反复尝试。

建议：只对结构化、明确的超窗错误触发收缩/摘要，并在模型尚未产生需要提交的输出、工具尚未执行的边界重试；每模型步骤限次，连续低收益压缩熔断。测试必须证明不会重复执行写工具、不会重复展示已提交正文。524 属于代理超时，不应直接归类为上下文超窗。

### 7. 按信息价值清理，恢复可验证的工作状态

当前固定保留最近 8 个 Frame；一个完整工具轮只计一个 Frame，大小可能相差数十倍。旧工具整轮折叠时调用名称、参数和结果一起消失；最终收缩多采用保头，可能丢掉日志尾部的失败原因。

建议：近期保留区同时受用户轮次和 token 预算约束；优先清理可重新读取的成功工具大正文，保留失败状态、路径/范围/版本、执行结论和变更归属。压缩后补回已有 canonical 计划、活跃写入状态、最近关键文件引用。重新读取必须走现有工具权限和新鲜度检查，不把旧文件内容视作当前事实，不额外发起无界自动读取。可复用现有 read-state 和 ResourceLink；本项不引入检索式长期记忆或自研记忆召回管线。

## P2：历史组装、来源边界与成本

### 8. 分开稳定指令、任务状态与历史摘要

位置：`apps/runtime/src/agent/context/context.ts:256`；`agent/context/task-context.ts`。

现有 checkpoint 被直接拼进 system，摘要却来自用户和工具内容。任务状态模块已经明确使用 user control 以保留来源等级。应把历史摘要同样作为带来源标记的历史数据处理，并用稳定的 system 规则说明其用途，避免工具输出借摘要被提升为系统命令。

这是一处来源/信任边界风险，本次未构造攻击链或证明审批可被绕过。现有 Rust/权限强制边界必须保留。

稳定的系统指令、可变任务状态和可变摘要也应分开投影，减少 checkpoint 更新对前缀缓存的影响。不同协议在 Provider 适配层处理：Anthropic 可使用支持的缓存块；OpenAI 依赖稳定前缀及其实际协议语义，不盲目发送 Anthropic 字段。现有 message validator 对 system 位置的要求需同步演进，不能直接复制 ZCode 多 system 消息结构。

### 9. 从水位线重建，并把压缩过程做成可诊断状态

位置：`apps/runtime/src/agent/context/context-frames.ts:35`、`:59`；`agent/context/context.ts:269`。

目前每次启动 Run 都先载入全会话，再对每条 assistant 单独查询工具记录，之后才验证和应用 checkpoint。长会话存在全量读取与 N+1 查询成本。可以增加水位线后的批量历史读取与来源 revision 校验，避免优化时削弱 retry/supersede/edit 的失效规则。

同时应区分“成功生成摘要”“复用 checkpoint”“确定性裁剪”“摘要失败后的降级”。当前构建指标 `compactionCalls` 固定为 0，后台摘要的模型用量也未见归入 Run usage。建议记录摘要调用的协议、逻辑请求 ID、输入/输出 token、实际覆盖区间、前后预算、耗时与失败原因；日志不含正文或凭据。后续增加用户可见的压缩状态、摘要查看与手动重试/压缩入口。

## 建议实施顺序与验收

1. **第一批：正确性。** 修复协议路由、实际覆盖水位线、无效摘要缓存和完整请求预算。验收三协议、晚到用户纠正、长工具输出尾部错误、非法 JSON/schema、超大受保护输入及大量 MCP schema。
2. **第二批：长任务连续性。** 引入轮内安全边界摘要、有效 checkpoint 的装入与精确超窗恢复。验收单 Run 连续多轮工具操作、取消、摘要失败、不能重复执行写操作及连续快速再溢出。
3. **第三批：成本和体验。** 优化稳定前缀、水位线查询、语义保留区、状态恢复与诊断。用相同任务比较压缩前后约束保留率、重复读文件次数、工具重复执行数、成功完成率、输入 token、缓存命中、首字延迟与总耗时。

暂不承诺具体 token 节省比例或模型质量提升。本次没有真实模型长任务 A/B、三平台运行或压缩质量基准；Node/SQLite/纯 TS 算法应保持三平台共用实现，平台路径与文件引用继续使用既有抽象。
