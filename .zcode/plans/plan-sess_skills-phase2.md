# Skills Phase 2：目录化发现 + 安装/启停 + 管理页

## 目标
把技能从 Phase 1A 的「内置只读注册表 + 斜杠激活 + skill.use 加载说明」升级到 Phase 2 的
**SKILL.md 目录化技能**：支持两级目录发现、**本地与远程安装**、启用/停用生命周期、管理页；保留
Phase 1A 已就位的激活链路、prompt 注入、`runs.skill_id` 落库。对齐 `AGENT-PLATFORM-PLAN` A3
的设计，且不越过"Skill 只能引用已注册 Tool、不得绕过 Tool/Policy 直访系统"的红线。

## 现状（Phase 1A 已就位，直接复用）
- 契约：`SkillManifestSchema`（id/name/version/description/tools/argumentHint）、`skill.list`、
  `message.send` 可选 `skillId`、`Run.skillId`。
- `apps/runtime/src/skills/`：`SkillRegistry`（注册时 contracts schema 校验，非法即失败）、
  `invocation.ts`（显式优先 / 斜杠激活 / 双 prompt 段注入）、`builtin/` 四个内置技能、
  `builtinSkills` 单例。
- Agent 集成：`agent/index.ts` 激活 + prompt 注入 + run 落库；`agent/tools/skills.ts`
  `skill.use`。
- 前端：`features/skills/SkillsView.tsx`（只读清单卡）、`api/skills.ts`、Composer 斜杠补全。
- 存储：`runs.skill_id` 已在 schema（v6）。`store/` 尚无 skills 领域文件。

## 已知待清理
- `docs/SKILL-SYSTEM.md` 只列 3 个内置技能，代码实为 4 个（多了 `verify-fix`）——文档与代码不一致，本期同步修正。

## 实现方案

### 1. 契约扩展（packages/contracts，先改这里）
- 扩展 `SkillManifestSchema` 或新增 `InstalledSkill` 类型，加入字段：
  - `source: 'builtin' | 'user' | 'project'`（来源，决定可操作性）。
  - `enabled: boolean`（启停状态）。
  - `installPath`（相对来源目录的路径，供管理页显示与卸载）。
- 新增命令：
  - `skill.install`（参数：来源——本地目录路径，或 `url` 远程地址）。
  - `skill.enable` / `skill.disable`（参数：skillId）。
  - `skill.uninstall`（仅 user/project 来源）。
  - `skill.list` 返回值改为 `InstalledSkill[]`（含 source/enabled）。
- 迁移：`runs` 已有 `skill_id`；无需加列，新增 `installed_skills` 表（见 §4）。

### 2. SKILL.md 目录格式（新 loader）
- 新增 `apps/runtime/src/skills/loader.ts`：解析 SKILL.md 目录——
  - frontmatter（name/description/allowed-tools/version）→ 校验并映射到 manifest；
  - 正文（Instructions）→ 按需加载（progressive disclosure：描述常驻、正文 skill.use 加载，沿用现状）；
  - 可选资源文件（同一目录内相对引用）。
- frontmatter 解析：轻量自写（对齐"少依赖"），不引 YAML 库；字段做白名单校验。
- `allowed-tools` 本期仅作**信息性**引用（与 manifest.tools 一致），不新增独立权限声明；
  真正能力边界仍由 Run 装配与权限 Profile 决定，Skill 不绕过。

### 3. 两级发现 + 装配（apps/runtime/src/skills/）
- 目录约定：
  - 用户级：`<数据目录>/skills/<skillId>/SKILL.md`（数据目录 = `REFLEXION_DATA_DIR ?? ~/.reflexion-os-studio`，复用 `store/shared.ts`）。
  - 项目级：`<workspace>/.reflexion/skills/<skillId>/SKILL.md`。
- 装配顺序与去重：`builtin`（内置）→ `user` → `project`；同 id 冲突以 project 覆盖 user、user 覆盖 builtin，且**冲突要在管理页可见**（标记为覆盖）。
- `builtinSkills` 单例升级为「内置 + 已安装 user + 当前项目已安装」的动态 Registry 装配器：
  由 `skills/index.ts` 暴露一个 `loadInstalledSkills(dataDir, projectPath)`，返回合并后的 Registry；
  激活链路/prompt 注入/`skill.use` 保持调用同一 Registry 接口，调用点从硬编码 `builtinSkills` 改为
  该装配结果。为降低改动面，项目级文件加载放在 Run 装配时传入（同 `createToolRegistry` 的 dataDir/workspace 参数模式）。

### 4. 存储：installed_skills 表（apps/runtime/src/store/）
- 新增 `store/skills.ts`：`installed_skills` 表（id、source、enabled、install_path、installed_at、updated_at），
  记录"已安装的技能清单 + 启停状态"。目录扫描负责加载内容，表负责持久化启停与卸载来源。
- `store/migrations.ts` 推进一个版本（v6→v7）加表；迁移沿用现有重建/事务模式。
- 启停是"状态"而非"删除文件"：`disable` 后 Registry 仍可扫描但装配时跳过（不注入 prompt、不参与斜杠补全），保留在清单页可重新启用。

### 5. 命令与装配接线
- `apps/runtime/src/handlers.ts`（或新增 `handlers-skills.ts`）：实现 install/enable/disable/uninstall/list。
  - `skill.install` 本地路径：扫描指定目录 → 校验 → 写 `installed_skills` 行 → 立即生效。
  - `skill.install` 远程 URL：见 §5a。
  - enable/disable：改行状态，触发当前装配的 Registry 重扫。
- Rust 侧白名单数组（`apps/desktop/src-tauri`）同步新增这些 command 名。
- `apps/runtime/src/agent/index.ts`：把硬编码 `builtinSkills` 换成装配结果；重试沿用原 `skillId` 的逻辑保持。

### 5a. 远程安装（复用 Runtime 现有 fetch，无新依赖）
Runtime 侧全局 `fetch` 已用于 `web.fetch`/provider/embedding，远程安装直接复用同一网络栈，
不需要新增依赖或权限 Profile（仍是宿主侧经白名单 command 触发的命令，不属于 Agent 工具）。

- **两种远程形态**：
  1. **单文件 URL**：`skill.install(url)` 指向一份 `SKILL.md`。Runtime `fetch` 拉取文本 → 走
     与本地一致的前置 frontmatter 校验 → 落到用户级 `<数据目录>/skills/<skillId>/SKILL.md` →
     写 `installed_skills` 行。多文件资源本期不支持（只装单文件）。
  2. **索引市场 URL**：指向一个 JSON 清单 `[{ id, name, description, version, source }]`。
     `skill.list.remote`（或 `skill.search`）拉取清单用于**管理页浏览**，选择某项后其
     `source` 是单文件 URL，再走形态 1 安装。索引 URL 可配在设置页（默认空，无内建市场）。
- **安全与校验**：
  - 仅 `https:`，拒绝 `http:` / `file:` / 非 HTTP（对齐"仅 https 放行"的资源引用纪律）。
  - 拉取后必须通过 `SkillManifestSchema` frontmatter 校验，非法即拒绝且**不落盘**。
  - URL 返回体大小上限（如 1MB），超限拒绝，防吞大文件。
  - 远程技能与本地同样走 `allowed-tools` 信息性引用边界，不带脚本执行，不绕过 Tool/Policy。
  - 安装来源 `source='user'`，不信任远程来源额外能力；同 id 冲突仍按 project>user>builtin 覆盖，
    管理页对远程安装项显示 `来源：远程`。
- 失败语义：下载失败 / 校验失败 / 大小超限都返回明确 `error_code`，不落半成品文件。

### 6. 前端管理页（features/skills/）
- `SkillsView.tsx` 升级为技能管理页：
  - 按来源分组（内置 / 用户 / 项目），卡片展示 source 标签、enabled 状态；远程安装项标注来源。
  - 操作：启用/停用开关（builtin 仅可停用不可卸载）、卸载（user/project）、**安装**（本地目录路径，
    或粘贴 `SKILL.md`/市场索引 URL 的远程安装；远程可先拉取校验预览再确认落盘）。
  - "在对话中使用"（创建独立 session 预填 `/<id>`）保留。
  - 冲突（project 覆盖 user/builtin）时卡片显示提示。
- `api/skills.ts` 扩展 install/enable/disable/uninstall/search 具名函数。
- Composer 斜杠补全数据源仍是 `skill.list`，自动包含启用的 user/project 技能。

### 7. 文档
- 同步 `docs/SKILL-SYSTEM.md`：修正内置技能数量（4 个）、补 Phase 2 落地说明。
- `docs/AGENT-PLATFORM-PLAN.md` A3 相应段落标记已实现；`docs/ROADMAP.md` Phase 2 待办移除 Skills 目录化项。
- 新增冒烟 `scripts/smoke-skills.mjs` 覆盖：目录扫描、frontmatter 解析、两级覆盖、install/enable/disable 状态、卸载、非法技能拒绝、v6→v7 迁移。

## 验证
- `pnpm format:check`、`pnpm lint`、根级 `pnpm typecheck`、桌面前端 `pnpm typecheck`。
- `pnpm build:packages`；`cargo fmt --check`、`cargo test`、`cargo check`（Tauri 白名单）。
- 冒烟：`scripts/smoke-skills.mjs` 全绿。
- 手动：管理页能看到内置 4 技能；在用户目录放一个 SKILL.md 技能 → 安装 → 启用 → 对话 `/<id>` 激活 + prompt 注入；disable 后不再补全/激活但保留清单；卸载后消失；项目目录技能仅在对应项目可用；斜杠补全不出现已停用技能。远程：粘贴一份 https `SKILL.md` → 校验预览 → 安装生效；粘贴 `http:`/非法 frontmatter/超大体 → 明确报错且不落盘；索引 URL 能在管理页浏览并选中安装。

## 不实现（边界）
- 不引入第三方技能市场平台/账号体系（索引市场仅"可配的 URL 清单"，无内建来源；无评分/审核/自动更新）。
- 远程安装一期只支持**单文件 `SKILL.md`**；技能目录打包（zip/tar、多文件资源）后期再加。
- Skill 不新增独立权限声明，不带脚本执行（MVP 禁用脚本资源，仅 Instructions + allowed-tools 信息性引用）。
- 不做技能编辑/自动更新 UI（卸载重装即可）。
- 不涉及 Provider/Tool 插件、Browser Tool（属 Phase 2 其它待办）。
