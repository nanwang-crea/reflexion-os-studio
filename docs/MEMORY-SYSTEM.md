# Memory System（V2：文件即记忆）

> 日期：2026-09-12。本文描述 **Memory V2（文件即记忆）**，整体取代 A2 的 mem0 式
> SQLite 自动记忆管线（提取/合并/召回/worker/管理页）。设计推导与决策记录见
> `docs/superpowers/specs/2026-09-12-file-based-memory-and-instructions-design.md`
> （含 §11「实施修订记录」，实现与设计的差异以该节与代码为准）。

## 1. 四层框架的去向

历史上的四层划分（Working / Session / Project / Long-term）现在按职责切开：
**Working 与 Session 两层归上下文引擎**——Run 内目标/计划/工具摘要与跨轮历史由
增量 Checkpoint、压缩与 Frame 重建承担，机制见 `docs/CONTEXT-MANAGEMENT.md`，
本文不再涉及；**真正跨会话持久的记忆**由下面的"文件即记忆"三层承担；
**原始事实**留在 SQLite，不提取、不冗余。

## 2. 文件即记忆三层

| 层       | 位置                                                | 谁写                 | 角色                                     |
| -------- | --------------------------------------------------- | -------------------- | ---------------------------------------- |
| 指令     | `<DATA_DIR>/AGENTS.md`（全局）                      | 用户                 | 纪律与规范，只读注入                     |
| 指令     | `<project.folderPath>/AGENTS.md`（项目）            | 用户 / 仓库作者      | 项目纪律，只读注入；remember 永不写它    |
| 记忆     | `<DATA_DIR>/MEMORY.md`（全局）                      | remember 工具 + 用户 | 跨项目稳定偏好/教训，注入 + 可写         |
| 记忆     | `<DATA_DIR>/memories/<projectId>/MEMORY.md`（项目） | remember 工具 + 用户 | 本项目纪律与踩坑，注入 + 可写            |
| 原始事实 | SQLite（messages / runs / tool_calls）              | 系统                 | 不提取、不冗余；未来检索式记忆的检索对象 |

路径唯一解析在 `apps/runtime/src/agent/instructions/paths.ts`：

- 项目级 MEMORY.md 放数据目录而非用户仓库——不污染 git、不与仓库自有文档冲突，
  与资产存储 `<DATA_DIR>/assets/<projectId>` 同构；
- 项目级 AGENTS.md 读 workspace 根——那是用户/上游仓库的文件，只读不写，避免与
  其他编码工具混写；
- 项目级路径的 `projectId` 必须先过 store 存在性校验才参与拼接——不存在即拒，
  防任意字符串携 `../` 逃出数据目录。

## 3. remember 语义与信任模型

- **免审批**：`memory.remember` 的免审批依据是"只写数据目录内应用自管文件"，
  审批策略表显式 auto-allow（与 `time.now` 同级）；可感知性由现有工具轨迹卡承担
  （结果回显写入路径与内容），不新增事件。
- **单条形态**：content 非空、≤200 字、**必须单行**（含换行即拒——条目一行一条是
  聚合与截断语义的前提，内嵌换行会伪造多条目注入）；追加格式 `- <YYYY-MM-DD> <content>`；
  目标文件不存在则带 `# 记忆` 标题骨架创建。
- **机密拒绝**：`containsSecretLike` 命中的内容直接拒绝写入——记忆文件绝不落盘凭据。
- **体积闸门**：MEMORY.md 超 64 KB 拒绝追加并引导到指令页整理；指令页 save 上限
  256 KB（AGENTS.md 允许用户写长文档）。
- **进程内串行链**：remember 与 save 共用同一条 Promise 写链——两者都对同一文件
  做读-改-写，必须互斥，否则 rename 冲掉交错写入的条目；save 用临时文件 + rename
  原子替换，失败清理半成品 tmp。
- **错误折叠**：remember 把读-判-写全程磁盘异常（EACCES/ENOSPC/EISDIR…）折叠为
  `io_error` 错误文案返回给模型，**绝不抛异常中断 Run**；`scope:'project'` 而会话
  无项目（或项目不存在）返回明确错误，引导改用 `global`。
- **无自动提取**：Run 终态不再产生任何后台 LLM 调用；写入入口只有模型显式
  remember 与用户手动编辑两个。系统 prompt 约定：用户明确纠正、表达稳定偏好、
  协作沉淀出项目纪律时调用；用户说"记住 X"必须调用；记结论不记流水账。

## 4. 注入设计

装配点在 `agent/context.ts`（`ContextBuilder.build`），顺序固定四层：

```text
base system prompt → 全局 AGENTS → 项目 AGENTS → 全局 MEMORY → 项目 MEMORY
```

- **项目覆盖语义**：项目 AGENTS 段头部标注"与全局指令冲突时以本段为准"。
- **每文件预算 4000 token**：复用 agent-core 的 `estimateTokens` 估算口径
  （`render.ts` 以别名 `estimateTextTokens` 再导出，单一真源，不本地复刻）；
  超限保头截断并在段尾标注 `⚠️ 内容过长，已截断`。
- **缺失静默**：每次 Run 装配时实时读文件（新鲜度优先，不缓存、无 watcher）；
  文件不存在/读取失败静默跳过，构建异常吞掉返回空串——注入永不拦对话。
- **信任边界**：项目 AGENTS.md 的内容等同注入指令，这是设计意图（Claude Code
  同模式），由用户对打开的文件夹负责；文件由 TS Runtime 进程直读（同 `secrets.json`
  待遇），不走 Rust 系统工具通道；前端仍只经 `runtime_request`，红线 2 不受影响。

## 5. 生命周期

**无自动治理**：不做衰减、去重、自动整理——治理放在指令页手动编辑；规模失控由
64 KB / 256 KB 闸门显式暴露给用户。**项目删除随清**：删除项目时清理其
`<DATA_DIR>/memories/<projectId>/` 目录，清理失败不阻塞删除，由启动时孤儿目录
清扫兜底（`sweepOrphanMemoryDirs`，与 Asset recover 同构语义）。

## 6. 命令面与指令页

- Runtime 命令（`agent/instructions/handlers.ts`，契约 zod 先行）：
  - `instructions.get { scope, projectId?, kind: 'agents'|'memory' } → { path, content }`
  - `instructions.save { scope, projectId?, kind, content } → { ok, message }`
  - get/save 对"存在但不可读"的文件抛错上抛（命令层映射 internal）——编辑器不得
    把不可读静默伪装成空，与注入路径的吞错语义有意分道。
- 前端 `features/instructions/`：全局/项目两分区 × AGENTS.md/MEMORY.md 共四个
  编辑区，展示实际文件路径；未保存草稿在切换分区/项目时经页内确认弹窗守卫
  （脏草稿守卫，与文件查看器同源模式）。

## 7. 旧链路删除说明

v23 迁移直接 `DROP TABLE` memories / memories_fts / memory_jobs，**存量数据不搬迁**
（用户决策"全删"——A2 自动提取的记忆质量不配迁移成本），真相源从此只有文件。
相关契约（`memory.*` 命令、`memory.written` 事件、Memory 实体类型）、Runtime
`agent/memory/` 整个目录与前端记忆管理页一并删除。Provider 契约中的 `embedding`
capability **保留**，为未来检索方案预备。

## 8. 演进承诺

当文件规模需要检索式召回时：**整体引入 mem0 等成熟方案，直连原始 SQLite 对话
数据**，不再自研提取/合并/召回管线。本设计不留任何自研检索通路。
