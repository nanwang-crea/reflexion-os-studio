# Plugin Foundation 与 Skill Plugin 外部化（设计规格 · 草案 v0.1）

> 状态：**已评审，批 1 已落地**。目录发现、工作区目录安装、启停、状态持久化、隔离与管理 UI
> 已实现；拖拽交互及 git/file 安装仍按第 8 节后续批次推进。
> 参考实现：旧 `../ReflexionOS`（Python）的 skill_registry / package_resolver / plugin_loader
> ——仅参考模式与交互形态，**不参考其安全边界**（旧项目允许加载第三方 Python 代码，本项目不允许）。

## 0. 背景与目标

Skills 子集（内置注册表、斜杠激活、`skill.use`）已落地，但它仍是"编译期内置"，不是可安装的能力包。
用户诉求：像市面主流（Claude Code `~/.claude/skills/` 等）一样——**有一个固定的 skills 存放目录，
放进去即被发现；支持拖拽安装与从 git 仓库安装；可启停、可卸载；重启后状态保持**。

本设计确立一条架构决策：**插件基础设施先做，但首个且当前唯一可安装类型是 Skill**。
这样既完成 Skills 的外部化，也建立一套随后可直接承载 Provider/Tool 插件的契约，不会出现
"只能服务 Skills、随后被推翻"的临时系统。

非目标（本批不做）：

- 不加载任何第三方可执行代码（JS/Python/Shell/原生）——Skill 第一版是**纯声明式内容包**；
- 不做插件市场/在线索引/自动更新（update 只做"按指定来源重新解析"）；
- 不实现 Provider Plugin / Tool Plugin 的加载逻辑（只冻结契约槽位）；
- 不改 MCP——MCP 继续走现有独立协议适配层（`mcp_servers`），不为"统一"而重写；
- 不引入 PyPI 包安装。

## 1. 核心决策

| #   | 决策                                                                                         | 理由                                                                    |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D1  | **固定目录即发现**：全局 `<dataDir>/skills/`（默认 `~/.reflexion-os-studio/skills/`）        | 对齐市面主流；数据目录已有同构先例（`memories/`、`assets/`）            |
| D2  | **SKILL.md 单文件格式**：frontmatter + 正文（Markdown instructions）                         | Claude Code 事实标准，社区可直接复用既有 skill 包；旧项目同格式         |
| D3  | **插件类型枚举**：`PluginKind = 'skill' \| 'provider' \| 'tool'`，当前只实现 `skill`         | 契约冻结、实现收窄，避免提前铺开                                        |
| D4  | **Registry 注入化**：现有 `builtinSkills` 单例改为由 Runtime 装配处注入 `SkillRegistry` 实例 | 消除 4 处硬编码引用（agent/index、launcher、handlers、tools），可测试性 |
| D5  | **生命周期持久化到 SQLite**（`plugins` 表，schema v25）                                      | 重启后 enabled/installed 状态保持——首批验收目标之一                     |
| D6  | **git clone 走 Rust 侧 system runtime**，不在 TS Runtime 里执行 git                          | 网络和工作区外写属系统层能力；遵守红线：文件/网络类能力经 Rust 边界     |

## 2. Skill 包格式（SKILL.md）

一个 Skill Plugin = `<dataDir>/skills/<skill-id>/SKILL.md`。

```text
<skill-id>/
├── SKILL.md          # 必需。frontmatter + instructions 正文
└── assets/           # 可选。静态资源（截图、模板等），仅作引用，不执行
```

frontmatter 字段（全部必填除非注明可选）：

| 字段           | 类型           | 约束                                                        |
| -------------- | -------------- | ----------------------------------------------------------- |
| `id`           | string         | `^[a-z0-9][a-z0-9-]*$`（与现有 SkillManifestSchema 一致）   |
| `name`         | string         | 非空                                                        |
| `version`      | string         | 非空；安装时记录，更新对比用                                |
| `description`  | string         | 非空                                                        |
| `tools`        | string[]       | 信息性：该 skill 建议使用的工具名；不授予任何权限           |
| `argumentHint` | string \| null | 可选；斜杠命令参数占位提示                                  |
| `compat`       | object         | 可选：`{ protocol: "1.3" }`——低于当前协议版本要求则拒绝安装 |
| `source`       | string         | 可选：作者自述来源（信息性，不参与校验）                    |

正文即 instructions，注入方式与现有内置技能完全一致（激活后进 system prompt；
`skill.use` 加载返回全文）。

**格式注意**：frontmatter 是 YAML，但**本项目的校验真源是 zod schema**——frontmatter 只做
浅层解析（键值与列表级），未知字段拒绝（`z.object({}).strict()`），不引入完整 YAML 库。

### 内置技能迁移

4 个内置技能（code-review / verify-fix / web-research / workspace-report）改用同一 frontmatter
契约（TS 里生成对象，不必落盘成文件），`source: 'builtin'`，不可停用/卸载（UI 置灰），
随应用发布。`skills/` 目录只放外部技能。

## 3. 发现与注册

- **启动扫描**：Runtime 启动时扫描 `<dataDir>/skills/` 下每个一级子目录，读取 SKILL.md、校验、
  登记。解析失败的单个 skill 不阻塞启动（记 warning 日志 + 状态 `invalid`），带病不崩。这是与
  内置技能的差异：内置注册失败即启动失败（编程错误），外部 skill 解析失败只跳过该目录。
- **缓存**：instructions 全文缓存进 registry 内存；DB 只存元数据与状态。
- **ID 冲突**：安装时与内置/其他外部冲突 → 明确报错；启动扫描发现重复 → 后扫到的标 `invalid`，
  内置优先。
- **项目级 skills 目录**（`<project>/skills/`）**本批不做**：全局目录先行，项目级留待后续批
  （旧项目支持项目级，但首版收窄，见第 8 节批注）。

## 3.5 安装通道（本批范围）

三条安装通道，全部收敛到同一 `plugin.install` 命令（`source` 区分）。

### 拖拽安装（`source: 'dir'`，工作区内）

技能页提供拖拽区，接受**工作区内**的 skill 目录/文件拖入（复用 Asset 导入同款通道）：

- 拖入 `SKILL.md` 文件 → Runtime 读取 + 校验 + 安装到 `<dataDir>/skills/<id>/SKILL.md`；
- 拖入目录 → 读取目录下 SKILL.md（不递归扫描多级）；
- **不做**系统级任意路径拖入（无 Tauri dialog 命令；前端 dataTransfer 拿不到工作区外路径）；
- 前端只传 workspace 相对路径；实际文件复制由 Runtime 侧 fs 完成（工作区内 → 数据目录）。

### git 安装（`source: 'git'`）

`plugin.install` 的 specifier 支持四种格式（与旧项目一致）：

```text
owner/repo                     # GitHub short
https://github.com/owner/repo  # GitHub URL
name@git+https://...#ref       # 任意 git
file://绝对路径                 # 本地目录（工作区外允许，经用户显式确认）
```

- git clone 由 **Rust system runtime** 执行（浅克隆 `--depth 1` + 记录 `.ref`/`.commit`），
  克隆到 `<dataDir>/skills/<name>/`；网络授权走现有 shell 网络审批（`requires_network` 同款语义）；
  clone 成功后 TS 侧校验 SKILL.md 并登记。
- `file://` 本地安装允许任意路径（含工作区外）——用户在 UI 显式输入/确认路径，Runtime 复制内容
  进数据目录（**不 symlink**——symlink 是逃逸口，拒绝）。
- 安全约束：clone 后的目录在 TS 侧只读解析 SKILL.md，不以任何形式执行其内容；克隆进来的
  `.git/` 目录不删除（保留 git 元信息便于更新），扫描时跳过。

## 4. 统一插件契约（contracts）

新增（`packages/contracts/src/plugins.ts`）：

```ts
PluginKindSchema   = z.enum(['skill', 'provider', 'tool'])          // 只实现 skill
PluginStatusSchema = z.enum(['installed', 'enabled', 'disabled', 'invalid'])
PluginSourceSchema = z.enum(['builtin', 'dir', 'git', 'local'])
PluginRecordSchema = z.object({                                     // strict：未知字段拒绝
  id, kind, version, name, description,
  source: PluginSourceSchema,
  sourceRef: string.nullable(),   // git url 或 file:// 路径；dir/builtin 为 null
  status: PluginStatusSchema,
  installPath: string.nullable(), // <dataDir>/skills/<id>；builtin 为 null
  enabled: boolean,               // status === 'enabled'
  compat: z.object({ protocol: z.string() }).nullable(),
  error: string.nullable(),       // 解析/校验失败原因
})
PluginSpecifierSchema = z.string().refine(...)   // 四种格式之一
```

命令（进 `commands.ts`；白名单 JSON 由 contracts 生成，Tauri 侧 `build.rs` 已实现自动同步，
无需手改 Rust）：

```text
plugin.list          → { plugins: PluginRecord[] }
plugin.install       → params { source: 'dir'|'git'|'local', ref?, path? }
                        result { plugin, installedSkills: [...] }
plugin.uninstall     → { id }
plugin.toggle        → { id, enabled }
plugin.rescan        → {}   # 重扫 skills 目录（用户修复文件后手动触发）
plugin.changed       → 事件：安装/卸载/启停/状态变化广播
```

协议版本 `1.2` → **`1.3`**（新增命令与事件；握手 fail-closed 语义不变）。

### 与 MCP 的关系

MCP **不并入** PluginRecord 体系：`mcp_servers` 表与现有命令保持独立。Plugin Foundation 的
契约（manifest/version/status）为 MCP 未来归一预留结构兼容（kind 枚举可扩展），但本批不迁移。

## 5. 安全与隔离边界（红线）

1. **纯声明式内容包**：Skill 只含 Markdown 与静态资源。**禁止**任何可执行代码（JS/Python/Shell/
   原生）。frontmatter 与 instructions 都按**不可信数据**处理，绝不解释为指令（与
   `AGENTS.md` 第 12 节注入防御同源）。
2. **能力不经 manifest 授予**：`tools` 字段是信息性的。Skill 实际能调用什么工具，仍由
   **Run 装配的 ToolRegistry + PermissionGate + 审批链路**决定，与现在完全一致。manifest 里
   声明 `tools: ['shell.execute']` 不构成任何授权——这是插件体系不绕过权限模型的核心保证。
3. **安装时校验清单**（任何一项失败即拒绝安装，不给"先装后验"的机会）：
   - manifest schema 校验失败（含未知字段、非法 id、缺必填项）；
   - **路径穿越**：skill id 不能含 `..`、绝对路径或路径分隔符；
   - **符号链接逃逸**：安装来源与目标路径禁止 symlink（拖拽通道在复制前 lstat 检查，
     `file://` 渠道解析真实路径后只复制内容）；
   - **重复 ID**：与内置或已安装 skill 冲突；
   - **兼容性**：`compat.protocol` 高于当前协议版本；
   - instructions 为空（与现有 registry.register 约束一致）。
4. **无提权通道**：插件安装/启停是普通工作区操作，**不**涉及 Danger 租约或提权；网络只在
   git 安装时按现有 shell 网络审批规则申请。插件目录写入数据目录，不经工作区写授权之外的范围。
5. **UI 诚实性**：管理页的"权限声明"只展示 manifest 里 `tools` 字段的信息性说明，文案必须
   明示"实际可用性由权限策略与审批决定"，不得暗示插件拥有尚未开放的权限。
6. **失效即隔离**：`invalid`/`disabled` 状态的 skill 不进 system prompt 清单、`skill.use` 拒绝
   返回内容、斜杠命令不激活（视为普通文本，与现有未知斜杠语义一致）。

## 6. 存储与迁移

- 新增 `plugins` 表（schema v24 → **v25**）：`id`（主键，= skill id）、`kind`、`version`、
  `source`、`source_ref`、`status`、`install_path`、`enabled`、`compat_json`、`error`、
  `created_at`/`updated_at`。
- `store/plugins.ts` 为领域层（与 `mcpServers.ts` 同构：list/get/create/update/toggle/remove），
  业务代码只调领域方法，不直接写 SQL。
- 启动恢复：先从 DB 读出已登记插件恢复状态，再与磁盘扫描对账——磁盘存在但 DB 无记录
  → 新发现并标 `installed`（默认启用）；DB 有记录但磁盘缺失 → 标 `invalid` 并保留 error，
  不自动删除记录（用户可在 UI 卸载）。
- 旧库（v24 及以前）无 plugins 表，迁移建表即可，无数据搬运。内置技能不入库（随版本发布）。

## 7. 管理 UI（技能页改造）

现有 `SkillsView` 从"只读清单"升级为"管理页"：

- 分组展示：内置技能（置灰停用/卸载按钮）、已安装外部技能；
- 每张卡片展示：来源徽章（内置 / 目录 / git / 本地）、版本、状态徽章（启用 / 停用 / 无效）、
  `error` 行（`invalid` 时展示原因与"重扫"按钮）；
- 操作：启用/停用开关、卸载（二次确认，仅删 DB 记录与数据目录内副本，
  `source: 'git'` 时连同克隆目录删除）、重扫；
- 安装入口（顶部工具条）：**拖拽区**（接受工作区内目录/文件）+ **specifier 输入框**
  （git 四种格式）+ 安装中状态与错误反馈；
- 权限说明行按第 5 节第 5 条措辞。

## 8. 分阶段实施计划

每批独立可交付、有验收标准；批 1 是最小闭环（你提的首批验收目标）。

### 批 1：目录发现 + 启停 + 状态保持（MVP 闭环）

- contracts：PluginRecord/PluginSpecifier schema + `plugin.*` 命令 + `plugin.changed` 事件；
  协议 1.2 → 1.3；白名单 JSON 重新生成。
- runtime：`store/plugins.ts`（schema v25 迁移）；`skills/` 目录扫描器（SKILL.md 解析、
  strict zod 校验、invalid 容错）；`builtinSkills` 改注入式（D4）；启动对账恢复；
  `plugin.list/install(dir 通道)/toggle/uninstall/rescan` 命令 handler。
- frontend：`api/plugins.ts`；SkillsView 卡片加来源/版本/状态/启停开关/卸载确认。
- **验收**：往 `<dataDir>/skills/` 放一个合法 SKILL.md → 技能页出现、斜杠命令可激活、
  `skill.use` 返回全文；停用后立即不可调用（清单/斜杠/use 全部隔离）；重启后状态保持；
  非法 skill（坏 manifest/路径穿越/重复 id）被拒且给出错误原因，不崩溃。

### 批 2：拖拽安装

- frontend：拖拽区组件（工作区内路径），调 `plugin.install { source: 'dir', path }`。
- runtime：目录复制进 `<dataDir>/skills/`（lstat 拒 symlink、拒绝 `..`/绝对路径）。
- **验收**：从工作区拖入目录与单文件两种形态均成功；拖入含 symlink 的目录被拒并说明原因。

### 批 3：git / file:// 安装

- rust system runtime：`plugin.git_clone`（浅克隆 + `.ref`/`.commit` 元信息），走现有网络审批。
- runtime：specifier 解析（四种格式）→ 调 Rust 克隆 → 校验 SKILL.md → 登记；
  `file://` 复制内容不 symlink。
- frontend：specifier 输入框 + 安装进度/错误反馈。
- **验收**：`owner/repo`、GitHub URL、`git+https://…#ref` 三种格式各安装成功一次；
  克隆后无 SKILL.md 的仓库被拒并提示；网络失败折叠为错误文案而非崩溃。

### 批 4（后续，不属本批）：项目级目录 + 更新

- `<project>/skills/` 项目级目录；`plugin.update`（重新拉取并对比 commit）；
  Provider/Tool Plugin 加载（启用 D3 预留槽位）。
- **明确不实现**：插件市场、自动更新、第三方可执行代码加载。

## 9. 待评审的开放问题

1. `skills/` 目录是放在**全局数据目录**（`~/.reflexion-os-studio/skills/`，跨项目共享）还是
   跟随项目？本文按全局写（D1），理由是"能力"通常跨项目复用；若你认为应项目级优先，批 1 范围需调。
2. 内置技能迁移到 frontmatter 契约时，是否也把 4 个内置 SKILL.md 真的落盘到数据目录
   （便于用户查看/参考格式）？本文按"TS 内生成对象"写，不落盘。
3. 卸载 git 来源的 skill 时，是否保留克隆的 `.git` 以便"重装快"？本文按"连同删除"写
   （数据目录是应用自管空间，用户可重装）。
4. 批 3 的 git clone 需要新增 Rust 侧能力 `plugin.git_clone`，会动 system runtime 的
   命令集；是否接受，还是倾向先用 TS 侧 `shell.execute` 调系统 git 走 shell 审批？
   后者更快但权限粒度更粗（D6 倾向前者）。
