# 设计：文件即记忆 —— AGENTS.md 指令层 + MEMORY.md 记忆层（Memory V2）

日期：2026-09-12
状态：已实施（分 6 次提交合入 feature/file-based-memory；实现与本文的差异见 §11「实施修订记录」，以代码为准）
前置：A2 mem0 式本地记忆管线（提取/合并/召回/管理页）已上线，本设计将其整体移除。

## 1. 背景与问题

现有记忆系统每个 Run 终态后自动提取候选记忆（LLM 抽取 → LLM 合并 → 落 SQLite），
再以混合召回注入上下文。实际使用中暴露四个症状，且用户确认全部命中：

1. **提取内容太琐碎**：从 transcript 盲抽产出的多是流水账、临时性细节；
2. **垃圾积累无人清理**：写入不经用户确认，无有效生命周期；
3. **注入的经常不相关**：召回命中质量差，白占 token；
4. **该记的记不住**：用户纠正、失败教训等真正有价值的信息反而没沉淀。

结论：症状 1/2/4 根因都在"从 transcript 自动提取"这一步；为其配衰减/淘汰算法
不改变"抽出来的就是垃圾"的事实。主流产品（Claude Code / ChatGPT / Cursor / Letta）
的共识路径是：**显式/模型主动写入 + 文件形态的指令层 + 人可管理的生命周期**，
对话摘要归上下文引擎（本项目已有 checkpoint/compaction，不在本设计范围）。

## 2. 目标与非目标

**目标**

- 引入指令文件层：全局 + 项目的 `AGENTS.md` 自动注入每次 Run；
- 引入 `memory.remember` 工具：模型在对话中主动把稳定偏好/项目纪律/教训写进
  应用自管的 `MEMORY.md`（全局/项目两档），免审批、用户可查看编辑；
- 彻底删除 SQLite 自动记忆管线（提取/合并/召回/worker/表/页面），
  记忆只保留"文件"一条真相源；
- 记忆管理页原地改造为"指令"页（四类文件的查看与编辑）。

**非目标**

- 不做"从本会话提炼"候选队列、不做自动提取的任何降级形态；
- 不为原始事实（messages/runs/tool_calls，本就在 SQLite）建检索索引；
- 不做记忆自动衰减/去重/整理（治理放 UI 手动）；
- **架构承诺**：未来若文件规模需要检索式召回，整体引入 mem0 等成熟方案直连
  原始对话数据，不再自研提取/召回管线。本设计不留任何自研通路。

## 3. 三层上下文模型

| 层       | 位置                                                                 | 谁写                 | 角色                                 |
| -------- | -------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| 指令     | `<DATA_DIR>/AGENTS.md` + `<project.folderPath>/AGENTS.md`            | 用户 / 仓库作者      | 纪律与规范，只读注入                 |
| 记忆     | `<DATA_DIR>/MEMORY.md` + `<DATA_DIR>/memories/<projectId>/MEMORY.md` | remember 工具 + 用户 | 稳定结论/偏好/教训，注入 + 可写      |
| 原始事实 | SQLite（messages / runs / tool_calls）                               | 系统                 | 不提取、不冗余；未来 mem0 的检索对象 |

决策记录：

- **项目级 MEMORY.md 放数据目录而非用户仓库**：不污染 git、不与仓库自有文档冲突；
  与资产存储 `<DATA_DIR>/assets/<projectId>` 同构。
- **项目级 AGENTS.md 读 workspace 根**：那是用户/上游仓库的文件，我们只读不写。
  remember 工具不写 AGENTS.md（避免污染用户仓库、与其他编码工具混写）。

## 4. 注入设计（Runtime 侧）

新模块 `apps/runtime/src/agent/instructions/`：

- `loader.ts`：按当前 session 解析四个候选文件路径并读取（`fs.readFile`，
  每次 Run 装配时读，新鲜度优先，不缓存、无 watcher）；不存在/读失败静默跳过。
  - 全局 AGENTS.md：`join(dataDir, 'AGENTS.md')`
  - 项目 AGENTS.md：`join(project.folderPath, 'AGENTS.md')`（folderPath 为空跳过）
  - 全局 MEMORY.md：`join(dataDir, 'MEMORY.md')`
  - 项目 MEMORY.md：`join(dataDir, 'memories', projectId, 'MEMORY.md')`
- `render.ts`：渲染注入块。顺序固定：base system prompt → 全局 AGENTS →
  项目 AGENTS → 全局 MEMORY → 项目 MEMORY；项目 AGENTS 段头部标注
  "与全局指令冲突时以本段为准"。每文件预算 4000 token（复用 agent-core 的
  `estimateTokens` 估算口径，`render.ts` 以别名 `estimateTextTokens` 再导出，
  不本地复刻），超限保头截断并在段尾
  标注 "⚠️ 内容过长，已截断"。
- 接线点：`agent/context.ts:207` 的 `buildMemoryBlock` 调用整体替换为
  `buildInstructionBlock(store, session)`；异常吞掉返回空串（与现 memory
  注入同语义：不拦对话）。

**边界与红线核对**：由 TS Runtime 进程直读本地文件（同 `secrets.json` 待遇），
不走 Rust 系统工具通道、不经沙箱审批——协议文件而非用户数据；前端仍只经
`runtime_request`，红线 2 不受影响。项目 AGENTS.md 内容等同于注入指令，
这是设计意图（Claude Code 同模式），安全文档中如实标注为信任边界的一部分。

## 5. memory.remember 工具

- 注册：`agent/tools/instructions.ts`，装配进每 Run 工具集（同 `skill.use`
  纯 TS 工具路径）；工具直接调用 `instructions/service.ts` 的 `remember()`
  （与 UI 共用的 `instructions.get/save` 命令面只提供查看/保存，不提供 remember）。
- 参数：`{ scope: 'global' | 'project', content: string }`；content 非空、
  ≤200 字、`containsSecretLike` 命中则拒绝（机密不进记忆，规则从旧
  `memory/filter.ts` 迁移为共享 util）。
- 行为：目标文件不存在则创建（`# 记忆` 标题 + `## 记忆条目` 小节）；
  追加一行 `- <YYYY-MM-DD> <content>`；文件大小上限 64 KB，超限返回错误
  文案引导用户到指令页整理。写入在进程内用 Promise 链串行化，避免
  并发 Run 交错写。
- **免审批**（用户决策）：只写数据目录内应用自管文件；审批策略表显式
  标记该工具 auto-allow，与 `time.now` 同级。可感知性由现有工具轨迹卡承担
  （工具结果回显写入路径与内容），不新增事件。
- `scope:'project'` 且会话无项目 → 返回错误，提示改用 `global`。
- 系统 prompt（`prompts/primary-agent.ts`）追加一段行为约定：用户明确纠正、
  表达稳定偏好、或协作中沉淀出项目纪律时调用；记结论不记流水账；
  用户说"记住 X"时必须调用；先浏览已有记忆避免重复。

## 6. UI：指令页

- `features/memories/` 原地改造为 `features/instructions/`：侧栏与路由文案
  "记忆" → "指令"；页面为全局/项目两个分区（项目用下拉选择现有项目），
  每分区展示实际文件路径 + textarea 编辑 + 保存 + 重新读取；MEMORY.md 与
  AGENTS.md 各一个编辑区（共 4 区，空文件给出创建提示）。
- 新 runtime 命令（`instructions/handlers.ts`，注册进 `handlers.ts` 合并表）：
  - `instructions.get { scope, projectId?, kind: 'agents'|'memory' } → { path, content }`（文件不存在返回空 content + 解析出的 path）
  - `instructions.save { scope, projectId?, kind: 'agents'|'memory', content } → { ok }`
- 契约：删除 `memory.list/update/delete` 命令与 `memory.written` 事件；
  新增 `instructions.*` 命令定义（zod，contracts 先行）。

## 7. 删除清单（一次删净）

Runtime：

- `agent/memory/` 整个目录（extractor / merge / merge 决策 / recall / service /
  worker / embedding / filter / similarity / job-provider / handlers）；
  `filter.ts` 的 `containsSecretLike` 迁到 `agent/instructions/` 或共享 util。
- `agent/prompts/memory-extractor.ts`、`memory-merger.ts` 及 prompts/index 导出。
- `agent/index.ts`：MemoryService/MemoryWorker 装配、`onMemoryJob` 通知、
  前台抢占调用（index.ts:48-63, 250-251）。
- `agent/launcher.ts` / `agent/runner.ts`：`onMemoryJob` 透传链与
  `enqueueMemoryJob` 决策位（runner.ts:135-136, 234 等）。
- `agent/context.ts`：`buildMemoryBlock` 注入点（替换为 §4）。
- `store/`：`memories.ts`、`memoryJobs.ts`、`index.ts` 中实例与
  `memoryJobs.recoverRunning()`、终态事务入队点。
- `store/schema.ts`：移除两张表 DDL；`migrations.ts` 新增一版迁移：
  `DROP TABLE IF EXISTS` memories / memories FTS / memory_jobs（版本号 +1，
  存量数据一并删除——用户决策"全删"）。

Contracts：`MemoryScope/Kind/Status/MemorySchema`（entities.ts:355-401）、
`memory.*` 命令（commands.ts:399-420）、`memory.written` 事件（events.ts:143-146）。

前端：`api/memory.ts`、`features/memories/*`、`useAppBootstrap` 中
`memory.written` 监听、Sidebar/TopBar/AppMain/main.tsx 入口与路由。

Providers 侧的 `embedding` capability **保留**（契约字段无害，未来 mem0 需要）。

测试：删除 `memory.test.mjs`、`memory-job.test.mjs`；新增
`instructions.test.mjs`：四文件解析顺序与缺失跳过、4000 token 截断与标注、
remember 追加/建文件/无项目报错/机密拒绝/64KB 上限、instructions.get/save
往返、终态事务不再入队记忆 job。

## 8. 错误处理与降级

- 注入：任何读取/渲染异常 → 跳过该文件块，对话照常（吞错 + stderr 日志）。
- remember：校验失败/超限 → 工具返回错误文案（模型可见，可自行调整重试），
  不抛异常不中断 Run。
- instructions.save：写失败返回错误；写入用临时文件 + rename 原子替换。
- 启动恢复：无 memory worker 需要恢复；旧库残留 job 随迁移 drop 消失。

## 9. 跨平台核对（红线 8）

- 路径全部 `node:path` join，数据目录复用 `REFLEXION_DATA_DIR` 现有解析；
  三平台同构，无平台分支。
- 文件写：UTF-8 无 BOM、`\n` 换行（三端一致，`fs.appendFile` 显式 `\n`）。
- 权限：MEMORY.md 非机密，默认文件权限即可（不做 0600 平台分支）。

## 10. 验收标准

1. 全新会话的上下文中出现四个文件的注入块（存在即注入、缺失静默）；
2. 对话中说"记住：以后都用 pnpm"→ remember 落全局 MEMORY.md，
   下一个会话直接生效；
3. Run 结束后零 LLM 后台调用（memory_jobs 不再产生）；
4. 指令页可查看/编辑四个文件并即时生效；
5. `pnpm build` 全链 + 测试通过；旧库升级迁移平滑（drop 后启动正常）；
6. 文档同步：本文件、`MEMORY-SYSTEM.md` 改写、`AGENTS.md` §1 能力清单与
   §2 目录表更新、`ROADMAP.md` 记录。

## 11. 实施修订记录

评审（Task 3–6）挣得的与正文的差异，以实现为准：

1. **memoryPath 过 store 校验**（`instructions/paths.ts`）：项目级 MEMORY.md 路径
   拼接前 `store.projects.get(projectId)` 必须命中，未命中返回 null——防任意字符串
   携 `../` 逃出数据目录；正文 §4/§5 未提及该校验。
2. **单行不变量**（`instructions/service.ts`）：remember 内容拒绝 `\r`/`\n`/
   U+2028/U+2029——条目必须独占一行才能安全聚合与截断，内嵌换行会伪造多条目注入。
3. **remember 与 save 共用一条串行写链**：两者对同一 MEMORY.md 都做读-改-写，
   必须互斥（否则 rename 冲掉交错条目）；正文 §5/§8 只写了 remember 串行。
   save 另有 256KB 内容上限（AGENTS.md 允许长文档，区别于 64KB 追加闸门）。
4. **IO 错误折叠分层**：remember 把读-判-写全程异常折叠为 `io_error` 错误文案
   （模型侧工具绝不抛异常中断 Run）；save/get 对真实磁盘故障**上抛**由命令层映射
   internal（编辑器不得把"存在但不可读"伪装成空），仅 ENOENT/ENOTDIR 视作缺失。
5. **前端脏草稿守卫**（`features/instructions/`）：切换 scope/项目前对未保存
   修改弹应用内确认，与 FileViewerPanel 同源模式；正文 §6 未涉及。
6. **记忆目录生命周期**：项目删除随清 `<dataDir>/memories/<projectId>/`
   （失败不阻塞删除），启动时清扫无项目行对应的孤儿目录
   （`sweepOrphanMemoryDirs`，与 Asset recover 同构）；正文未涉及。
7. **token 口径复用 agent-core**：`render.ts` 以别名 `estimateTextTokens` 再导出
   agent-core 的 `estimateTokens`，不本地复刻估算函数（正文 §4 已含此句，此处存档）。
