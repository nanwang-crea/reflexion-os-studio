# Workflow MVP：语言模型 Agent 协作图

> 状态：MVP 设计与实施记录，更新于 2026-10-14。W0–W5 语言模型 MVP 已实现；macOS 合成 Provider GUI 已验收，Windows/Linux 真机与真实模型质量仍待验证。
> Phase 4 首版优先语言模型；图片、视频生成保留扩展边界，实际交付仍属后续阶段。

## 1. 产品定位与边界

Workflow 是用户定义、保存并重复运行的 Agent 协作流程。用户配置角色与任务，
通过连线指定成果如何交接；引擎按确定的图调度，Agent 在节点内完成任务。
复杂任务、并行任务本身不要求使用 Workflow；需要固定协作方式和重复运行时使用它。

| 概念           | 职责                                             | 生命周期               |
| -------------- | ------------------------------------------------ | ---------------------- |
| 角色模板       | Prompt 为核心，附带可收窄的工具与权限策略        | 可跨流程复用、可修改   |
| Agent 节点     | 某个角色在流程中的具体任务、模型、输入输出和预算 | 随流程版本保存         |
| Agent 执行实例 | 一次节点尝试中实际启动的 Agent 与独立 Run        | 每次尝试新建，配置冻结 |
| 动态子 Agent   | 父 Agent 在运行中通过 task 决定的委派            | 随任务动态产生         |
| Workflow       | 用户确定的节点、依赖与成果传递规则               | 版本化定义，多次执行   |

Workflow 调度器决定启动哪个节点；Agent 决定如何完成节点任务。Agent 不能自行
增加节点、修改连线、跳过确认或启动下游。它可以提出流程调整建议，用户修改后
形成新版本。Workflow 的 Agent 执行复用现有内核，不依赖模型调用 task 来调度。

首版工具由 Agent 内部调用，不提供工具节点。角色不写死为职业枚举；产品经理、
设计师、开发者、测试者、灵感提供者、写作者、编辑者都使用同一种 Agent 节点。

### 首版交付

- 项目级流程创建、编辑、校验、保存版本、手动运行、历史与删除治理。
- 自然语言生成单个角色节点或完整协作图，审阅后应用到草稿，与人工编辑共用契约。
- Agent 节点、人工确认节点；流程级输入和输出，不要求用户摆放开始/结束节点。
- 文本、受限结构化 JSON、工作区/Asset 资源引用的显式端口。
- 有向无环图；串行、并行、全部前置依赖汇合。
- 运行配置预检、权限审批、共享预算、取消、节点状态和轨迹。
- 已完成节点成果复用，以及对不确定副作用的保守恢复。

### 首版不交付

自动定时触发、条件路由、循环、批量 map、子工作流、节点内部
动态委派、无人值守自动修订、通用回滚、第三方可执行节点插件和媒体生成。
这些属于后续批次；编辑器和占位页不提前展示可用入口。

## 2. 两条产品验收流程

### 代码 Builder

```text
需求输入 → 产品经理 ─→ 设计师 ───────┐
                  └→ 测试规划者 ───┼→ 开发者 → 测试者 → 人工确认 → 交付
                  └────需求文档─────┘
```

产品经理输出需求与验收标准；设计师输出交互/实现设计；测试规划者输出测试计划。
开发者收到三份指定成果后修改代码；测试者运行测试并输出 verdict 和问题清单。
verdict 不通过时仍可以成功产出审查报告，不能将“完成测试节点”解释为“测试通过”。
流程结束状态与最终验收结论分别展示；人工确认可拒绝交付。首版由用户依据问题
清单启动新一轮修订运行，无自动回边。

同一工作区内开发与测试按依赖串行安排，避免测试读取未完成的写入。并行节点
默认用于调研和规划；具备写权限时仍由共享 mutation coordinator 串行化每次写操作，
这不等于隔离完整任务。首版不承诺并行开发者拥有独立 checkout。

### 写作流程

```text
主题输入 → 灵感提供者 → 写作者 → 编辑者 → 语言润色者 → 人工确认 → 成稿
```

输出包括候选构思、稿件、编辑意见和最终正文。输出契约由用户配置，不限定职业。
两个样例作为内置流程示例，用户可复制修改，不能在引擎里硬编码流程行为。

## 3. 定义、模板与运行快照

WorkflowDefinition 保存 definitionId、projectId、revision、schemaVersion、名称、
描述、输入输出、nodes、edges、预算和布局。revision 为用户版本；schemaVersion
为协议格式版本，两者分离。已发布版本不可原地修改；保存修改创建新版本。
运行绑定版本并冻结实际执行配置，后续编辑不改变历史或活动运行。

Agent 节点包含 nodeId、名称、角色模板引用与保存时的模板快照、taskPrompt、
输入输出端口、modelBinding、策略收窄项和预算。模板引用用于编辑与溯源，运行
使用快照；模板更新仅提示用户主动应用，再保存新流程版本。

现有 AgentTemplate 以 systemPrompt + policy 为基础，应复用并提供适配，不新增
平行的角色注册表。节点任务提示与角色 Prompt 分开；安全指令拥有更高优先级，
上游成果作为数据注入，不能拼入高优先级系统指令。模型配置属于节点执行配置，
不要求修改现有动态子 Agent 继承父模型的语义。

modelBinding 首版支持流程默认模型或显式 providerId/model。运行前解析为快照；
只引用 secretRef，不存凭据。不同节点可选择不同语言模型；缺失、禁用或不支持
chat 的 Provider 在执行前阻止启动。模型级结构化输出支持不能仅凭能力声明推断。

### 自然语言生成：首版正式能力

用户可描述“创建产品经理、设计师、开发者和测试者的 Builder”，生成角色 Prompt、
节点任务、输入输出和连线；也可描述一个角色，添加到现有草稿。生成的角色配置
默认内嵌在节点中，不自动注册全局模板；用户可另行主动保存为可复用角色模板。

首版支持两种明确模式：生成完整新流程；在当前草稿添加一个节点及候选连线。
单节点生成携带当前端口摘要，不默认上传工作区文件或完整运行历史。首版不支持
自然语言任意重写已有图；用户通过画布编辑，或生成新的候选图比较后替换草稿。

生成链路：自然语言描述 → 候选定义 → 确定性校验 → 画布预览与人工编辑 →
用户应用草稿 → 校验保存 → 独立点击运行。生成、保存和运行是三个独立动作。
预览展示新增节点、Prompt、成果端口、连线、模型绑定、工具与权限建议；
不自动启动 Agent、不批准工具、不修改已保存版本或活动运行。

生成复用既有 Provider 与受预算/取消约束的普通模型 Run，禁用执行工具和 task，
仅输出定义。首版统一严格解析 JSON，不假定 Provider 支持原生结构化输出；最多两次有界修复，
每次计入同一生成预算。修复不能执行候选节点。最终无效时保留错误与候选草稿，
显示 generation_validation_failed，不保存为可运行版本；结构有效的候选可手动编辑并重新校验。

候选定义与手工定义使用同一 zod schema、图校验和引用校验；模型只能引用本次
提供的可用工具标识，不能发明可用能力。自动生成角色使用内嵌 Prompt、默认模型与
workspace-read 上限，不生成未提供的模板/模型选择；用户审阅后可通过节点配置或候选编辑
选择已有模板、Provider 与权限策略。系统分配持久 ID、来源与审计字段，不信任模型自报审批状态。
权限建议只作声明，默认 workspace-read；可写建议明确呈现并由用户配置，运行期
仍取权限交集。模型不得生成 grant、Danger 或绕过工具审批。

草稿有 revision；生成请求绑定基线 revision，应用时比较。用户生成期间编辑了图，
则保留候选并提示重新生成或人工合并，不能覆盖新编辑。取消、关闭和迟到响应
不会自动应用；生成中断不自动重发模型请求。用户再次生成是新的受预算请求。

新增 workflow_generations 保存来源、生成 Run、基线 revision、候选、校验错误与
状态；它是审计/草稿数据，不承担执行恢复。已知凭据形态在描述和候选写入前过滤，
workflow.generation.updated 只带状态/版本元数据。普通内部 Run 仍沿用消息/流式事件与轨迹；
业务日志不写描述或 Prompt 正文。生成来源永久记录；布局由编辑器确定性生成，不依赖模型坐标。

## 4. 端口、成果和连线

端口有 key、title、required 和 valueType；同一节点 key 唯一。首版类型：

| 类型     | 数据形态                | 校验                         |
| -------- | ----------------------- | ---------------------------- |
| text     | 有长度上限的 UTF-8 文本 | 类型与字节上限               |
| json     | 有大小/深度上限的 JSON  | 受限 JSON Schema 子集        |
| resource | workspace 或 Asset 引用 | 所属项目、可访问性和资源类型 |

JSON Schema 子集首版限 object/array/string/number/integer/boolean/null、
properties、required、additionalProperties、items、enum 和基础范围约束。
不支持外部 $ref、任意递归与组合逻辑；拒绝超预算 schema。
连线只允许相同类型，JSON 端口首版要求规范化 schema 完全一致，不声称实现完整
JSON Schema 子类型推导。复杂转换由显式 Agent 节点完成。

输入来源为流程输入、显式常量或一个上游输出；一个输入端口只有一个来源。
汇合通过多个具名输入端口表达，不做隐式拼接。下游仅取得绑定成果及项目标识，
不默认继承上游聊天历史、AGENTS.md/MEMORY.md 或任意工作区正文。

Agent 最终输出按节点契约确定性校验后才能发布。优先使用模型已支持的结构化
输出；否则解析严格 JSON 并校验。首版不自动重新执行 Agent 来修复格式：
不合格输出记 output_validation_failed，保留原始 Run 轨迹，禁止下游启动。
Changed Files、usage 和资源证据从 canonical ToolOutput/Run 数据投影，不能
由模型自行声称为已验证事实。资源引用只代表引用，不代表文件内容不可变。

发布的文本/JSON 成果不可变并记录 hash；资源成果保存发布时 revision/hash。
使用前复核资源身份和版本，变化时暂停并提示重新运行相关节点；文件删除、
资产不可访问不能静默替换为最新资源。首版不新增全文件 preimage 存储。

校验包含重复 ID、引用存在性、端口类型、必填输入、环检测、无效孤立节点、
输出可达性和策略上限。流程输入作为源、流程输出作为汇，参与可达性检查。
未接入最终成果路径的节点首版拒绝保存为可运行版本。

## 5. 执行架构与持久化

```text
前端画布 / 运行详情
  → frontend/api → runtime-client → Tauri runtime_request 白名单
  → Runtime workflow 服务 / 调度器
      → Agent 执行适配器 → 现有 RunLauncher / agent-core / PermissionGate
      → 人工确认服务
      → Store / 事件
```

Graph 算法保持纯 TypeScript，不访问 SQLite、Provider 或 Tauri。首版放在 Runtime
workflow/graph 子域；现有 packages 占位保持不变，不为了未来插件提前创建 SDK。
Runtime workflow/ 按 definitions、graph、execution、recovery 职责分层，根层保留
门面与 handlers。存储实现放 store/workflows/，业务只调用 store/index.ts 门面。

抽取内部 Agent 执行服务，供动态 task 与 Workflow 复用隔离上下文、启动、预算、
终态与工具装配。它不伪造父 ToolCall，不开放外部 delegation 写入口。WorkflowRun
是独立编排实体，不伪装成一次模型根 Run；Agent NodeAttempt 关联真实 Run/Session。
流程权限域、mutation coordinator 和共享预算使用明确的 workflowRunId 归属，
不能将它冒充现有 rootRunId。归属协议以加法方式扩展，并保留旧数据兼容。

建议 canonical 表：workflow_definitions、workflow_versions、workflow_runs、
workflow_node_attempts、workflow_outputs、workflow_confirmations。
NodeAttempt 唯一键为 workflowRunId/nodeId/attemptNo，并保存 Agent Run 关联、
输入 hash、执行快照、错误和副作用摘要。关联子 Run 与尝试的创建需单事务；
Run 终态与节点成果发布需幂等事务收敛。事件用于通知与审计，不作为恢复事实源。

迁移版本按实施时最新 schema 顺延；不能沿用 NL 草案的 v22，也不迁移角色到
新的 agent_definitions 表。流程删除先归档，有活动运行时拒绝清除；历史继续引用
原版本和成果。项目删除需要先取消并确认活动执行收敛，再清理关联数据。

## 6. 调度、状态与预算

NodeAttempt：pending → running → succeeded / failed / cancelled / interrupted；
人工确认使用 waiting_user → succeeded / rejected / cancelled。
WorkflowRun：pending、running、waiting_user、cancelling、succeeded、failed、
cancelled、interrupted。waiting_user 表示没有可运行/活动节点且存在待确认项；
仍有活动分支时流程继续显示 running，并单独标注等待确认。

所有必需前置成果发布后节点才可运行；独立分支在预算内并行，默认并发 2。
就绪队列按稳定节点顺序选取；同一运行只允许一个调度所有者，同一尝试只启动一次。
首版失败策略为 fail-fast：停止启动新节点，取消活动兄弟，保留已成功成果。
人工拒绝结束流程并记录 rejected 原因，不能显示交付成功。

共享预算包含节点尝试总数、并发、累计 token、工具调用和执行时间；节点预算
只能收窄总预算，重试和恢复不能重置已消耗额度。用户等待不占并发槽，执行时间
预算不计静态人工等待；等待仍受可配置的有效期约束。节点继续受现有 Run 预算限制。

取消先持久化 cancelling，禁止新调度，级联取消 Run 和确认项；确认活动执行收敛后
写 cancelled。迟到结果按尝试状态及版本拒绝发布，不能重新启动下游。
模型请求已有自动重试规则可复用；节点级自动重跑关闭，手动重试产生新 attempt。

## 7. 权限、确认与安全

启动页展示项目、模型、角色、工具范围、预算和可能写入行为。启动流程并不批准
所有未来工具调用；每次调用继续经过 PermissionGate 和 Rust 边界。
有效策略为用户本次权限 ∩ 模板策略 ∩ 节点限制 ∩ 平台硬边界。
Danger、一次授权和待处理审批不传递；ask-everything 在本次流程显式设置，
不能因节点切换而丢失。重启恢复建立新的内存权限域，不恢复会话授权规则。

业务确认节点与工具审批分开：确认稿件不授权写文件，允许一次文件写入也不表示
业务验收通过。确认展示冻结的成果、来源与版本，响应绑定 workflowRunId、
nodeId、attemptNo、成果 hash 和一次性 token；重复或过期响应拒绝。
人工确认的通过仅转发已审阅成果，不接受隐式编辑；编辑需形成明确的新输入运行。

网页、工具和上游模型输出保留来源信息并按不可信数据处理。延续机密拒读、
敏感过滤、日志纪律和注入披露；模板 Prompt 或生成成果不得提升权限。

## 8. 中断、恢复与修订

首版不承诺 exactly-once 副作用。崩溃可能发生在外部操作成功、结果落库之前；
仅靠节点状态不能确定操作有没有发生。恢复不能原样自动重跑。

启动先完成现有 Run interrupted 恢复，再收敛 Workflow 活动尝试；若 canonical
Run 已成功且成果已校验，幂等补齐发布，否则尝试记 interrupted。流程不自动续跑。
用户选择恢复后检查冻结版本、成果 hash、资源 revision、模型可用性和剩余预算。

- 已成功且成果有效的节点复用，不重跑。
- 尚未启动的节点可继续；新的执行重新接受权限检查。
- 纯模型、无工具副作用的中断节点可由用户重试，结果可能不同。
- 有写入、Shell、网络外部操作或效果不明的节点必须显示已有轨迹和变更，
  由用户核查后明确选择重新执行；首版不自动判断 Shell/网络请求幂等。
- 中断时的确认 token 作废；恢复后基于同一有效成果重新创建确认。

恢复仅允许同一流程运行快照；更换图、模型配置、输入或模板属于新运行。
手动重试仅限未成功节点，后继尚未执行；首版不支持在原运行覆盖成功节点并
追溯失效整个下游。测试不通过后的修订创建新运行，用户显式带入问题清单与
最新工作区状态，不自动复用旧报告或代码成果。

## 9. 用户界面

Automations 页在本阶段增加 Workflow 分区，定时任务仍显示尚未开放。
编辑器使用 React Flow，提供角色节点、端口连线、配置面板和校验错误定位；
流程默认模型与输入输出在侧栏配置。布局与执行语义分离。

运行页显示图状态、节点尝试、指定输入输出、预算、工具审批和业务确认；
点击 Agent 节点进入真实子 Session 轨迹。Changed Files 使用现有 canonical
投影，并展示节点归属。成功、验收结论和文件已改变分别呈现。

恢复界面明确列出复用节点、待执行节点和需核查副作用的节点，不提供通用回滚按钮。
事件订阅只接线一次，高频进度合帧，按节点局部更新，空闲无常驻轮询。

## 10. 多媒体扩展边界与三平台

沿用 ProviderCapability 的 chat/embedding/image/video，首版运行仅接受 chat。
内部节点执行适配器统一输入快照、取消信号、进度、结果发布和错误；Agent 适配器
使用模型循环，未来图片/视频适配器可使用直接调用或异步任务，不强行进入 chat。
媒体参数、外部任务 ID、费用和远端取消语义后续定义，不提前固定完整媒体协议。
resource 端口未来增加图片/视频约束；Asset 引用继续作为交接方式。

图、契约与调度为跨平台 TS；文件/Shell 经现有 Rust 系统服务与平台沙箱，路径使用
node:path/PathBuf。macOS、Windows、Linux 采用同一运行协议与 UI；不新增 bash
产品逻辑或本地 HTTP。平台不可用工具在预检中拒绝或由用户修改节点工具范围，
不得静默回退为无沙箱执行。三平台真机验证分别记录，macOS 通过不代表三平台通过。

## 11. 命令、事件与实现批次

已实现命令：workflow.list/get/save/archive/validate、workflow.run.start/get/list、
workflow.run.cancel/resume/retry_node、workflow.confirm.respond；
生成命令为 workflow.generate/get_generation/cancel_generation/apply_generation，
以及 workflow.draft.list/save、workflow.generations.list、workflow.edit_generation。
参数明确 mode、draftId/baseRevision、描述与生成模型。apply/edit 比较候选 stateVersion，
apply 仅修改草稿，不启动运行；save 将定义版本和草稿关联在同一事务内提交。
全部先在 contracts 用 zod 定义，再接 runtime-client、Runtime handler 与 Rust 白名单。
requestId 去重，start 重复请求返回同一运行；恢复/重试使用状态版本比较，防止并发点击。

事件实际收敛为 workflow.run.updated，以 stateVersion 驱动节点/成果/确认详情查询。
沿用事件信封与关联 ID；payload 只带 ID、
状态和有界摘要，不传大段 Prompt、输入输出或凭据。生成另有
workflow.generation.updated 事件；前端通过 typed API 获取详情。

| 批次 | 内容                                                   | 退出条件                          |
| ---- | ------------------------------------------------------ | --------------------------------- |
| W0   | contracts、状态机、纯图校验、存储设计与 Agent 适配接口 | 契约/校验/权限边界测试通过        |
| W1   | 串行 Agent 执行、成果发布、手动启动、取消、轨迹        | 写作样例不依赖画布可完整运行      |
| W2   | 并行汇合、共享预算与写协调、失败收敛                   | Builder 与故障测试通过            |
| W3   | 人工确认、中断恢复和手动重试                           | 崩溃窗口/副作用不重复执行测试通过 |
| W4   | 定义管理、React Flow 编辑器、运行与恢复 UI             | 两条样例 GUI 与性能验收通过       |

每批有错误、取消与恢复边界；不能先开放半成品入口。W1–W3 可由测试夹具驱动，
新增 W5：自然语言单节点/完整图生成、候选预览、校验修复与草稿应用；
退出条件为两条样例均可由自然语言生成，经用户审阅保存后完整运行。
W4 可作为内部验收版本，W5 通过后交付首版正式入口；自然语言生成属于本阶段必交付范围。

## 12. 验证与设计取舍

生成验证覆盖单节点/完整图、无效 JSON、引用不存在、权限自授拒绝、有界修复、
取消/迟到结果、草稿版本冲突，以及生成不触发执行和保存不触发运行。
必要测试覆盖图环/引用/类型/预算、并行上限、同节点重复启动、输入成果不可变、
模型输出不合格、审批拒绝、业务拒绝、取消与迟到结果、Run/成果事务崩溃窗口、
恢复失效资源、含副作用重试确认、跨节点 revision 冲突和 requestId 幂等。
使用合成 Provider 与临时工作区，不读取真实凭据或浏览器登录态。

实现交付执行 AGENTS.md 的格式、lint、根/前端 typecheck、构建、Rust 检查/测试与
打包流程，并补对应 TS 单测。事件/UI 改动需要 dev 空闲 CPU/RSS 基线和实测，
以及三平台、窄窗口、键盘和高 DPI 验收；未做的项目逐项说明。
本文仅修改设计文档，文档验证不作为上述实现验收证据。

本版采用以下取舍：节点以 Agent 协作为主；固定 DAG；工具在 Agent 内部；
模板保存时冻结；JSON 类型采用受限子集与相同 schema 连线；无节点级自动重跑；
恢复保持原快照；业务修订新建运行；多媒体保留适配边界。这些规则作为首版
实现依据，后续扩展通过版本化契约和独立设计变更，不静默扩大首版行为。

## 13. W0 实施记录（2026-10-13）

开发分支：`feature/workflow`。本批落地 contracts/workflow 的严格 zod 定义与
JSON Schema 导出、纯图/端口/成果校验、状态转换表、模型工具预检与策略交集，
以及版本化定义存储和模板快照。定义整体上限为 2 MiB、32768 项、32 层；
单个 JSON 成果/schema 上限为 256 KiB、4096 项、16 层，递归解析前先检查预算。

SQLite schema 44 仅新增 workflow_definitions/workflow_versions，现有角色表
保持不变。保存使用事务与 baseRevision 比较，旧版本不可覆盖；归档保留历史。
选用模板时由 Runtime 读取实际模板快照，不信任调用方覆盖模板策略；旧快照
保持不变，用户明确更新后才使用最新模板。首版模板委派能力与 task 均移除。

W0 交付时执行器只有内部接口与预检，未注册外部命令或开放 UI。
后续 W1–W3 已补齐执行与恢复及 typed API，见下一节；W4–W5 产品入口仍未开放。

本批新增 23 项测试覆盖契约、图、状态、预检、版本冲突、模板冻结与旧库升级。
最终新增 23 项测试全部通过；全量回归 Contracts 80、Agent Core 65、Runtime Client
25、Runtime 546 pass + 4 平台 skip、前端 81、System Runtime 233 均通过；冒烟、
终端故障矩阵 26/26 与白名单检查通过。format/lint、根/前端 typecheck、
build:packages、两个 Rust workspace 格式检查和宿主 cargo check 通过。
macOS app/DMG 打包通过；首次受限环境 hdiutil 失败，在支持系统磁盘映像操作的
环境重新执行后成功。最后的小幅输入防护调整已重跑 23 项测试和静态检查。
三平台真机、安装包启动 GUI 和空闲资源采样未执行；本批未改事件接线或流式 UI。

## 14. W1–W3 实施记录（2026-10-13）

本批先 review W0，修正集合预算、工具去重、状态写入约束、模型配置冻结，以及
可选端口原型成员读取问题；详情见 [review 记录](WORKFLOW-REVIEW-2026-10-13.md)。

后端已实现串行、并行汇合、独立 Agent Run、严格成果校验与发布、共享预算、
mutation coordinator、逐调用审批、业务确认、取消与故障收敛、显式恢复/重试。
Run 终态与结果 checkpoint 同事务提交；恢复不重放未知副作用。Root Run 状态与
节点尝试分开，attempt 终态不能复活；成功 Run 的有效 checkpoint 可核验后补发布。
最终成果按流程输出端口映射，Changed Files 从成功 canonical ToolOutput 投影并标明节点归属。

SQLite schema 45 加法新增 workflow_runs、workflow_node_attempts、workflow_outputs、
workflow_confirmations、workflow_attempt_results、workflow_requests；mutation_receipts
增加可空 workflow_run_id。Workflow Store 按定义/执行职责分层，业务继续经 Store 门面。
请求记录绑定项目并随项目级联删除；活动流程阻止项目删除与定义归档，事务内复查。

workflow.* 命令已接 contracts → runtime-client → Runtime → 生成的 Host 白名单；
运行历史分页返回摘要，详情按需读取。workflow.run.updated 事件携带状态/version
和真实 workflowRunId，不把它写入 runId。消费者按 stateVersion 处理重启/续跑旧事件。
业务确认有独立 token/hash/expiry；旧确认重启失效，拒绝不能直接续跑为通过。

Provider 配置在开始时冻结；当前禁用、模型移除和凭据引用撤销仍阻止执行。
缺失 usage 按保守估算计量并标记 tokensEstimated；取消/崩溃中的未知模型成本扣除节点预算，
无法确定的离线耗时按保守方式扣除。不保证供应商费用严格受 token 数字限制。
角色模板及一次授权不能扩大权限，Workflow 的 ask-everything 包括 MCP 每次调用，
Danger 不生效；业务确认不等于工具授权。内部 Session 仅用于轨迹，不接受普通发送/重试。

W4/W5 未实现，Automations 继续占位；此交付不宣称正式画布或自然语言入口可用。
测试与平台验收证据见 review 记录，真实模型效果和三平台 GUI 仍待对应验收。

## 15. W4–W5 实施与验收（2026-10-14）

Automations 页已接入实际 Workflow 入口，定时任务仍明确未开放。React Flow 支持
拖动、连线、节点删除、缩放、角色模板/Prompt/任务/模型配置；流程端口、绑定、
最终成果及预算通过高级 JSON 编辑。JSON 未应用编辑与当前配置冲突时拒绝覆盖。
运行页显示固定版本快照、节点状态、工具审批、人工验收、预算、成果、资源打开、
节点轨迹与显式恢复/重试；内部节点会话继续不进入普通聊天列表。

草稿和生成审计新增 schema v46。草稿独立 CAS revision，保存版本与草稿关联单事务；
生成绑定草稿基线，候选编辑与应用使用单调 stateVersion。运行不读取可变草稿。
生成使用隔离的普通 Run，空工具表且工具请求直接拒绝；初次请求和最多两次修正
共用 32000 token、120 秒预算，最多两个生成任务并行。模型采样配置在同次生成中冻结。
工具/token 费用仍按 Provider usage 或保守估算计量，不承诺供应商费用硬上限。

macOS 使用独立临时项目、本机合成 SSE Provider 和当前开发二进制完成：写作两节点
生成/应用/保存/运行；Builder 六节点并行汇合/人工验收/成功；在写作图新增润色者，
未保存版本前运行禁用，保存 v2 后三节点成功；节点轨迹查询。测试不使用真实密钥、
浏览器登录态或用户项目内容，不证明真实模型的规划或代码质量。

空闲四轮 top 采样，Runtime 均 0.0%，Host 0.0–0.1%，Renderer 0.0–0.7%，无持续空转。
ps RSS：Host 82.67 MiB、Runtime 45.52 MiB、Renderer 137.19 MiB。与 W0–W3 的同方法
CPU 0.0% 基线比较，当前接近空闲；数据/缓存/系统压力不同，RSS 不作为优化结论。
原始记录在临时目录 `/var/folders/0z/dpnv__6j40s_0cm9bkp5xzpw0000gn/T/reflexion-workflow-gui-cCm1ik`。
验收后测试应用、Node Runtime、Renderer、Rust sidecar 与合成 Provider 已退出。

审查、修复和最终验证见 [W4–W5 Review](WORKFLOW-REVIEW-2026-10-14.md)。未完成项：
Windows/Linux 真机、完整高 DPI/窄窗口矩阵、真实模型质量与长稳；不自动进入多媒体或调度阶段。
