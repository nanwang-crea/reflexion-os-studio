# 文件即记忆（Memory V2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 SQLite 自动记忆管线，改为"文件即记忆"：全局/项目 AGENTS.md + MEMORY.md 注入每次 Run，模型经免审批的 `memory.remember` 工具写 MEMORY.md，前端记忆页改造为指令页。

**Architecture:** 新增 `apps/runtime/src/agent/instructions/` 模块（路径解析/读取/渲染注入/读写服务/命令 handler）与纯 TS 工具 `memory.remember`；SQLite 侧 memories/memory_jobs 表经 v23 迁移 drop；前端 `features/memories` 替换为 `features/instructions`。Spec 见 `docs/superpowers/specs/2026-09-12-file-based-memory-and-instructions-design.md`。

**Tech Stack:** TypeScript（NodeNext、strict、Prettier 无分号单引号行宽 80）、zod（contracts 唯一真源）、node:sqlite、React + Vite、node --test。

---

## 前置条件（开工前必查）

1. **工作区必须干净**：当前工作树存在进行中的 Git 写操作改动（`crates/system-runtime/src/git/*`、`packages/contracts/src/commands.ts`、`packages/contracts/generated/runtime-methods.json` 等）。必须先让那次工作完成提交（或由用户确认 stash），否则本计划提交会混入无关 diff。验证：

   ```bash
   git status --short
   ```

   预期：只有本计划/设计文档相关条目。任何 `M`/`??` 的业务文件 → 停，找用户确认。

2. 全仓构建基线绿：

   ```bash
   pnpm format:check && pnpm typecheck && pnpm build:packages
   ```

3. 环境：命令均在仓库根执行（除非步骤注明 workdir）。`cargo` 不可用时先 `source ~/.cargo/env`（本计划不动 Rust，理论上无需 cargo 步骤，最后验证链仍要跑）。

## 文件结构（改动地图）

| 动作   | 路径                                                                                                                                                                                                                 | 职责                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Create | `apps/runtime/src/agent/instructions/paths.ts`                                                                                                                                                                       | 四类文件（global/project × AGENTS/MEMORY）路径解析 |
| Create | `apps/runtime/src/agent/instructions/loader.ts`                                                                                                                                                                      | 可选文件读取（缺失→空串）                          |
| Create | `apps/runtime/src/agent/instructions/secretGuard.ts`                                                                                                                                                                 | 机密形态过滤（从 `memory/filter.ts` 迁入）         |
| Create | `apps/runtime/src/agent/instructions/render.ts`                                                                                                                                                                      | token 估算/截断/注入块渲染                         |
| Create | `apps/runtime/src/agent/instructions/service.ts`                                                                                                                                                                     | remember / get / save 读写服务                     |
| Create | `apps/runtime/src/agent/instructions/handlers.ts`                                                                                                                                                                    | `instructions.get/save` 命令 handler               |
| Create | `apps/runtime/src/agent/tools/instructions.ts`                                                                                                                                                                       | `memory.remember` 工具                             |
| Create | `apps/runtime/test/instructions.test.mjs`                                                                                                                                                                            | 上述全部单测（随任务追加）                         |
| Create | `apps/desktop/frontend/api/instructions.ts`                                                                                                                                                                          | 前端命令封装                                       |
| Create | `apps/desktop/frontend/features/instructions/InstructionsView.tsx`                                                                                                                                                   | 指令页                                             |
| Create | `apps/desktop/frontend/features/instructions/instructions.css`                                                                                                                                                       | 指令页样式                                         |
| Modify | `packages/contracts/src/commands.ts` / `entities.ts` / `events.ts`                                                                                                                                                   | 增 instructions._；删 Memory_                      |
| Modify | `packages/runtime-client/src/index.ts`                                                                                                                                                                               | 删 Memory 再导出                                   |
| Modify | `apps/runtime/src/agent/context.ts`                                                                                                                                                                                  | 注入点替换（context.ts:206-211）                   |
| Modify | `apps/runtime/src/agent/index.ts`                                                                                                                                                                                    | 删 MemoryService/Worker 装配                       |
| Modify | `apps/runtime/src/agent/launcher.ts` / `runner.ts` / `run-finalizer.ts`                                                                                                                                              | 删 onMemoryJob/enqueueMemoryJob 链                 |
| Modify | `apps/runtime/src/agent/permissions.ts`                                                                                                                                                                              | `memory.remember` 免审批白名单                     |
| Modify | `apps/runtime/src/agent/tools/index.ts`                                                                                                                                                                              | 注册工具 + 调度策略                                |
| Modify | `apps/runtime/src/agent/prompts/primary-agent.ts`                                                                                                                                                                    | remember 行为约定                                  |
| Modify | `apps/runtime/src/handlers.ts`                                                                                                                                                                                       | 合并 instructions handler；删 memory handler       |
| Modify | `apps/runtime/src/store/schema.ts` / `migrations.ts` / `index.ts`                                                                                                                                                    | v23 迁移删表                                       |
| Delete | `apps/runtime/src/agent/memory/`、`prompts/memory-*.ts`、`store/memories.ts`、`store/memoryJobs.ts`、`apps/desktop/frontend/api/memory.ts`、`features/memories/`、`test/memory.test.mjs`、`test/memory-job.test.mjs` | 旧记忆链                                           |
| Modify | 前端 `App.tsx`/`AppMain.tsx`/`Sidebar.tsx`/`TopBar.tsx`/`main.tsx`/`useAppBootstrap.ts`/`useSessionNavigation.ts`                                                                                                    | 删记忆接线→加指令页                                |
| Modify | `docs/MEMORY-SYSTEM.md`、`AGENTS.md`、`docs/ROADMAP.md`                                                                                                                                                              | 文档同步                                           |

---

### Task 1: instructions 模块基座（paths / loader / secretGuard）

**Files:**

- Create: `apps/runtime/src/agent/instructions/paths.ts`
- Create: `apps/runtime/src/agent/instructions/loader.ts`
- Create: `apps/runtime/src/agent/instructions/secretGuard.ts`
- Test: `apps/runtime/test/instructions.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

新建 `apps/runtime/test/instructions.test.mjs`：

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { instructionPath } from '../dist/agent/instructions/paths.js'
import { readOptionalFile } from '../dist/agent/instructions/loader.js'
import { containsSecretLike } from '../dist/agent/instructions/secretGuard.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-instructions-')))
}

test('instructionPath: 全局两类文件在数据目录下', () => {
  const store = freshStore()
  const dataDir = process.env.REFLEXION_DATA_DIR
  assert.ok(dataDir, 'set-test-data-dir 应已注入 REFLEXION_DATA_DIR')
  assert.equal(
    instructionPath(store, 'global', 'agents', null),
    join(dataDir, 'AGENTS.md'),
  )
  assert.equal(
    instructionPath(store, 'global', 'memory', null),
    join(dataDir, 'MEMORY.md'),
  )
})

test('instructionPath: 项目 AGENTS.md 在项目 folderPath，项目 MEMORY.md 在数据目录', () => {
  const store = freshStore()
  const projectDir = mkdtempSync(join(tmpdir(), 'reflexion-proj-'))
  const project = store.projects.create({ name: 'P', folderPath: projectDir })
  assert.equal(
    instructionPath(store, 'project', 'agents', project.id),
    join(projectDir, 'AGENTS.md'),
  )
  assert.equal(
    instructionPath(store, 'project', 'memory', project.id),
    join(process.env.REFLEXION_DATA_DIR, 'memories', project.id, 'MEMORY.md'),
  )
})

test('instructionPath: 无项目/空 folderPath 返回 null', () => {
  const store = freshStore()
  assert.equal(instructionPath(store, 'project', 'agents', null), null)
  assert.equal(instructionPath(store, 'project', 'memory', null), null)
  const bare = store.projects.create({ name: 'B', folderPath: '' })
  assert.equal(instructionPath(store, 'project', 'agents', bare.id), null)
})

test('readOptionalFile: 缺失返回空串，存在返回内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-read-'))
  assert.equal(await readOptionalFile(join(dir, 'nope.md')), '')
  writeFileSync(join(dir, 'ok.md'), '你好\n')
  assert.equal(await readOptionalFile(join(dir, 'ok.md')), '你好\n')
  assert.equal(await readOptionalFile(null), '')
})

test('containsSecretLike: 拒绝凭据形态、放行普通句子', () => {
  assert.equal(containsSecretLike('我的 api_key: sk-abcdef0123456789'), true)
  assert.equal(containsSecretLike('密码：hunter2secret'), true)
  assert.equal(containsSecretLike('项目统一使用 pnpm 管理依赖。'), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `apps/runtime`）: `npx tsc -p tsconfig.json && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/instructions.test.mjs`
Expected: tsc 报错（找不到 `./instructions/paths.js`）——先注释掉 import 再跑只验证其余？不：tsc 失败即为"红"，直接进 Step 3 实现后重跑。

- [ ] **Step 3: 实现三个基座文件**

`apps/runtime/src/agent/instructions/paths.ts`：

```ts
import { join } from 'node:path'
import type { Store } from '../../store/index.js'
import { resolveDataDir } from '../../store/shared.js'

export type InstructionScope = 'global' | 'project'
export type InstructionKind = 'agents' | 'memory'

/**
 * 四类指令/记忆文件的唯一路径解析。
 * AGENTS.md（项目级）在用户仓库根——只读注入，remember 永不写它；
 * MEMORY.md 全部在应用数据目录（项目级按 <dataDir>/memories/<projectId>/
 * 隔离，与资产存储 <dataDir>/assets/<projectId> 同构），不污染 git。
 */
export function instructionPath(
  store: Store,
  scope: InstructionScope,
  kind: InstructionKind,
  projectId: string | null,
): string | null {
  const dataDir = resolveDataDir()
  if (kind === 'agents') {
    if (scope === 'global') return join(dataDir, 'AGENTS.md')
    if (projectId === null) return null
    const project = store.projects.get(projectId)
    if (!project || project.folderPath === '') return null
    return join(project.folderPath, 'AGENTS.md')
  }
  if (scope === 'global') return join(dataDir, 'MEMORY.md')
  if (projectId === null) return null
  // 记忆文件与 folderPath 无关，但 projectId 必须是真实存在的项目：
  // 否则任意字符串直接 join 进路径，可携 ../ 逃出数据目录隔离。
  if (!store.projects.get(projectId)) return null
  return join(dataDir, 'memories', projectId, 'MEMORY.md')
}
```

`apps/runtime/src/agent/instructions/loader.ts`：

```ts
import { readFile } from 'node:fs/promises'

/** 指令文件缺失/不可读都视为"没有这层上下文"，返回空串而不是抛错。 */
export async function readOptionalFile(path: string | null): Promise<string> {
  if (path === null) return ''
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
```

`apps/runtime/src/agent/instructions/secretGuard.ts`（从 `memory/filter.ts` 原样迁移 `containsSecretLike` 及其表；`parseJsonLoose` 随旧管线一起删除）：

```ts
/** 机密形态过滤：机密只存在于 secrets.json，绝不进记忆文件。 */

const SECRET_PATTERNS: RegExp[] = [
  // 常见密钥前缀形态：OpenAI/AWS/GitHub/私有部署 Key 等。
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Bearer / 赋值形态的凭据。
  /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i,
  /(?:密码|密钥|令牌|口令)\s*[:：=]\s*\S{6,}/,
  // 高熵长串（base64/hex 凭据常见形态）。
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/,
  /\b[a-f0-9]{64}\b/,
]

/** 形态上像机密的内容直接拒绝：宁可漏记一条记忆，不可落盘一个凭据。 */
export function containsSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（workdir `apps/runtime`）: `npx tsc -p tsconfig.json && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/instructions.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 格式与提交**

```bash
npx prettier --write apps/runtime/src/agent/instructions apps/runtime/test/instructions.test.mjs
git add apps/runtime/src/agent/instructions/paths.ts apps/runtime/src/agent/instructions/loader.ts apps/runtime/src/agent/instructions/secretGuard.ts apps/runtime/test/instructions.test.mjs
git commit -m "feat(memory): instructions 模块基座（四类文件路径/读取/机密过滤）"
```

---

### Task 2: 注入块渲染（render.ts）

**Files:**

- Create: `apps/runtime/src/agent/instructions/render.ts`
- Test: `apps/runtime/test/instructions.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

在 `instructions.test.mjs` 末尾追加（顶部补 import：`import { buildInstructionBlock, clipToTokenBudget, estimateTextTokens } from '../dist/agent/instructions/render.js'` 与 `mkdirSync, appendFileSync`）：

```js
function sessionInProject(store) {
  const projectDir = mkdtempSync(join(tmpdir(), 'reflexion-rt-proj-'))
  const project = store.projects.create({ name: 'RT', folderPath: projectDir })
  const session = store.sessions.create(project.id)
  return { project, projectDir, session }
}

test('estimateTextTokens: CJK 按字、拉丁按 4 字符', () => {
  assert.equal(estimateTextTokens('四个汉字'), 4)
  assert.equal(estimateTextTokens('abcdefgh'), 2)
})

test('clipToTokenBudget: 预算内原样、超预算保头截断并标记', () => {
  const text = '记'.repeat(5000)
  const kept = clipToTokenBudget('短内容', 4000)
  assert.equal(kept.truncated, false)
  const clipped = clipToTokenBudget(text, 100)
  assert.equal(clipped.truncated, true)
  assert.ok(estimateTextTokens(clipped.text) <= 100)
})

test('buildInstructionBlock: 四层顺序 + 缺失跳过 + 截断标记', async () => {
  const store = freshStore()
  const { project, projectDir, session } = sessionInProject(store)
  const dataDir = process.env.REFLEXION_DATA_DIR
  writeFileSync(join(dataDir, 'AGENTS.md'), '全局纪律：回复用中文。')
  mkdirSync(join(dataDir, 'memories', project.id), { recursive: true })
  writeFileSync(join(dataDir, 'memories', project.id, 'MEMORY.md'), '- 条目A')
  writeFileSync(join(projectDir, 'AGENTS.md'), '项目纪律：用 pnpm。')
  const block = await buildInstructionBlock(store, session.id)
  assert.ok(block.includes('全局指令'))
  assert.ok(block.includes('全局纪律：回复用中文。'))
  assert.ok(block.indexOf('全局指令') < block.indexOf('项目指令'))
  assert.ok(block.indexOf('项目指令') < block.indexOf('全局记忆'))
  assert.ok(block.indexOf('全局记忆') < block.indexOf('项目记忆'))
  assert.ok(block.includes('- 条目A'))
  // 空文件/缺失文件不产生段
  writeFileSync(join(dataDir, 'AGENTS.md'), '')
  const block2 = await buildInstructionBlock(store, session.id)
  assert.ok(!block2.includes('全局指令'))
})

test('buildInstructionBlock: 独立会话只有全局两层', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  writeFileSync(join(process.env.REFLEXION_DATA_DIR, 'AGENTS.md'), 'G')
  const block = await buildInstructionBlock(store, session.id)
  assert.ok(block.includes('全局指令'))
  assert.ok(!block.includes('项目指令'))
})
```

- [ ] **Step 2: 跑测试确认失败**（tsc 找不到 render.js 即红）

- [ ] **Step 3: 实现 render.ts**

`apps/runtime/src/agent/instructions/render.ts`：

```ts
import { estimateTokens } from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'
import { readOptionalFile } from './loader.js'
import {
  instructionPath,
  type InstructionKind,
  type InstructionScope,
} from './paths.js'

/** 复用 agent-core 的 token 估算口径（单一真源，不再本地复刻）：CJK/假名按字、其余按码点每 4 字符向上取整。 */
export { estimateTokens as estimateTextTokens }

/** 单个指令文件的注入预算（token）；超限保头截断并显式标注。仅模块内使用。 */
const INSTRUCTION_FILE_TOKEN_BUDGET = 4000

/** 按 token 预算保头截断；先按比例收缩再逐步收敛。 */
export function clipToTokenBudget(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  const total = estimateTokens(text)
  if (total <= budget) return { text, truncated: false }
  const ratio = budget / total
  let end = Math.max(0, Math.floor(text.length * ratio))
  let piece = text.slice(0, end)
  while (end > 0 && estimateTokens(piece) > budget) {
    end = Math.max(0, end - 64)
    piece = text.slice(0, end)
  }
  return { text: piece.trimEnd(), truncated: true }
}

const LAYERS: {
  scope: InstructionScope
  kind: InstructionKind
  label: string
}[] = [
  { scope: 'global', kind: 'agents', label: '全局指令（AGENTS.md）' },
  {
    scope: 'project',
    kind: 'agents',
    label: '项目指令（AGENTS.md；与全局指令冲突时以本段为准）',
  },
  { scope: 'global', kind: 'memory', label: '全局记忆（MEMORY.md）' },
  { scope: 'project', kind: 'memory', label: '项目记忆（MEMORY.md）' },
]

/**
 * 构建注入 system prompt 的指令/记忆块：全局 AGENTS → 项目 AGENTS →
 * 全局 MEMORY → 项目 MEMORY。文件缺失/读失败静默跳过；空块返回空串
 * （调用方按"没有这层上下文"处理）。
 */
export async function buildInstructionBlock(
  store: Store,
  sessionId: string,
): Promise<string> {
  const session = store.sessions.get(sessionId)
  const projectId = session?.projectId ?? null
  const sections: string[] = []
  for (const layer of LAYERS) {
    const path = instructionPath(store, layer.scope, layer.kind, projectId)
    const raw = await readOptionalFile(path)
    if (raw.trim() === '') continue
    const clipped = clipToTokenBudget(raw.trim(), INSTRUCTION_FILE_TOKEN_BUDGET)
    sections.push(
      `=== ${layer.label} ===\n${clipped.text}${
        clipped.truncated ? '\n⚠️ 内容过长，已截断。' : ''
      }`,
    )
  }
  if (sections.length === 0) return ''
  return `[指令与记忆文件 · 自动注入]\n${sections.join('\n\n')}`
}
```

- [ ] **Step 4: 跑测试确认通过**（命令同 Task 1 Step 4）

- [ ] **Step 5: 格式与提交**

```bash
npx prettier --write apps/runtime/src/agent/instructions/render.ts apps/runtime/test/instructions.test.mjs
git add apps/runtime/src/agent/instructions/render.ts apps/runtime/test/instructions.test.mjs
git commit -m "feat(memory): 指令/记忆四层注入块渲染（预算截断+缺失跳过）"
```

---

### Task 3: 读写服务（remember / get / save）

**Files:**

- Create: `apps/runtime/src/agent/instructions/service.ts`
- Test: `apps/runtime/test/instructions.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

顶部补 import：

```js
import { readFile } from 'node:fs/promises'
import {
  remember,
  getInstruction,
  saveInstruction,
} from '../dist/agent/instructions/service.js'
```

追加用例：

```js
test('remember: 全局首建带表头，追加带日期条目', async () => {
  const store = freshStore()
  const outcome = await remember({
    store,
    scope: 'global',
    content: '以后新建项目一律用 pnpm。',
    projectId: null,
  })
  assert.equal(outcome.ok, true)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.startsWith('# 记忆'))
  assert.ok(text.includes('## 记忆条目'))
  assert.match(text, /- \d{4}-\d{2}-\d{2} 以后新建项目一律用 pnpm。/)
  await remember({
    store,
    scope: 'global',
    content: '回复保持简短。',
    projectId: null,
  })
  const again = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  assert.equal(
    again.split('\n').filter((line) => line.startsWith('- ')).length,
    2,
  )
})

test('remember: 项目记忆落在数据目录 memories/<id> 下', async () => {
  const store = freshStore()
  const { project, session } = sessionInProject(store)
  const outcome = await remember({
    store,
    scope: 'project',
    content: '本项目迁移只增不改。',
    projectId: project.id,
  })
  assert.equal(outcome.ok, true)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'memories', project.id, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.includes('本项目迁移只增不改。'))
  void session
})

test('remember: 拒绝机密形态/超长/空白，项目 scope 无项目报错', async () => {
  const store = freshStore()
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: 'token: abcdefghijklmnop1234',
        projectId: null,
      })
    ).code,
    'secret_like',
  )
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: '字'.repeat(201),
        projectId: null,
      })
    ).code,
    'too_long',
  )
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: '   ',
        projectId: null,
      })
    ).code,
    'too_long',
  )
  const noProject = await remember({
    store,
    scope: 'project',
    content: '无项目',
    projectId: null,
  })
  assert.equal(noProject.ok, false)
  assert.equal(noProject.code, 'no_project')
})

test('remember: 文件超 64KB 上限时拒绝并提示整理', async () => {
  const store = freshStore()
  await saveInstruction({
    store,
    scope: 'global',
    projectId: null,
    kind: 'memory',
    content: 'x'.repeat(64 * 1024 + 10),
  })
  const outcome = await remember({
    store,
    scope: 'global',
    content: '再记一条',
    projectId: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'too_large')
})

test('get/save 指令文件往返', async () => {
  const store = freshStore()
  const { project, projectDir } = sessionInProject(store)
  const missing = await getInstruction({
    store,
    scope: 'global',
    projectId: null,
    kind: 'agents',
  })
  assert.equal(missing.content, '')
  assert.ok(missing.path.endsWith('AGENTS.md'))
  await saveInstruction({
    store,
    scope: 'project',
    projectId: project.id,
    kind: 'agents',
    content: '# 项目指令\n写入用户仓库根。',
  })
  const text = await readFile(join(projectDir, 'AGENTS.md'), 'utf8')
  assert.ok(text.includes('写入用户仓库根。'))
  const saved = await getInstruction({
    store,
    scope: 'project',
    projectId: project.id,
    kind: 'agents',
  })
  assert.equal(saved.content, text)
})
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 service.ts**

`apps/runtime/src/agent/instructions/service.ts`：

```ts
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Store } from '../../store/index.js'
import {
  instructionPath,
  memoryPath,
  type InstructionKind,
  type InstructionScope,
} from './paths.js'
import { containsSecretLike } from './secretGuard.js'

const MEMORY_FILE_HEADER =
  '# 记忆\n\n本文件由 ReflexionOS Studio 的 remember 工具与用户共同维护。\n\n## 记忆条目\n'
const MAX_ENTRY_CHARS = 200
/** MEMORY.md 体积上限：超限拒绝追加，提示到指令页整理（本轮不做自动治理）。 */
const MAX_MEMORY_FILE_BYTES = 64 * 1024
/** 指令页保存的内容上限（AGENTS.md 允许更大，用户在编辑器里写长文）。 */
const MAX_SAVE_BYTES = 256 * 1024

/**
 * remember 与 saveInstruction 共用一条进程内串行链：两者都对同一 MEMORY.md
 * 做「读-改-写」，并发 Run 的工具写入与用户在指令页的整文件保存必须互斥，
 * 否则 rename 会冲掉交错写入的条目。链本身对错误免疫（见各 .catch）。
 */
let writeChain: Promise<unknown> = Promise.resolve()

export interface RememberOutcome {
  ok: boolean
  code?: 'no_project' | 'too_long' | 'secret_like' | 'too_large' | 'io_error'
  message: string
  path?: string
  entry?: string
}

/** 模型主动记忆入口：追加一条 `- YYYY-MM-DD content` 到对应 MEMORY.md。 */
export function remember(input: {
  store: Store
  scope: InstructionScope
  content: string
  projectId: string | null
}): Promise<RememberOutcome> {
  const task = writeChain.then(() => rememberNow(input))
  // rememberNow 把一切（含 IO 错误）折叠为 outcome，不会抛错；catch 仅兜底保链。
  writeChain = task.catch(() => undefined)
  return task
}

async function rememberNow(input: {
  store: Store
  scope: InstructionScope
  content: string
  projectId: string | null
}): Promise<RememberOutcome> {
  const { scope, projectId } = input
  const content = input.content.trim()
  if (content === '' || content.length > MAX_ENTRY_CHARS) {
    return {
      ok: false,
      code: 'too_long',
      message: `记忆内容必须非空且不超过 ${MAX_ENTRY_CHARS} 字，当前 ${content.length} 字。`,
    }
  }
  // 单行不变量：条目独占一行才能安全聚合/截断，内嵌换行会伪造多条目注入。
  if (/[\r\n\u2028\u2029]/.test(content)) {
    return {
      ok: false,
      code: 'too_long',
      message: '记忆内容必须是单行，不能包含换行。',
    }
  }
  if (containsSecretLike(content)) {
    return {
      ok: false,
      code: 'secret_like',
      message: '内容疑似包含凭据，记忆文件绝不落盘机密，请去掉后再记。',
    }
  }
  if (scope === 'project' && projectId === null) {
    return {
      ok: false,
      code: 'no_project',
      message: '当前会话未关联项目，无法写项目级记忆；请改用 global 范围。',
    }
  }
  const path = memoryPath(input.store, scope, projectId)
  if (path === null) {
    // projectId 过了 store 校验才拼路径；不存在即拒，防目录逃逸。
    return {
      ok: false,
      code: 'no_project',
      message: '项目不存在，无法写项目级记忆；请改用 global 范围。',
    }
  }
  // 读-判-写整段都是磁盘操作，任一环节抛错（EISDIR/EACCES/ENOSPC…）折叠成
  // io_error：remember 是模型侧工具，绝不能因磁盘异常把异常抛回 Run 循环。
  try {
    const existing = await readIfAbsent(path)
    if (Buffer.byteLength(existing, 'utf8') > MAX_MEMORY_FILE_BYTES) {
      return {
        ok: false,
        code: 'too_large',
        message: `记忆文件已超 ${MAX_MEMORY_FILE_BYTES / 1024}KB 上限，请到指令页整理既有条目。`,
      }
    }
    const entry = `- ${new Date().toLocaleDateString('en-CA')} ${content}`
    await mkdir(dirname(path), { recursive: true })
    const prefix = existing === '' ? `${MEMORY_FILE_HEADER}\n` : ''
    // 旧文件缺尾换行时先补 \n，避免新条目粘在旧行行尾。
    const glue = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(path, `${prefix}${glue}${entry}\n`, 'utf8')
    return {
      ok: true,
      message: `已记住（${path}）：${content}`,
      path,
      entry,
    }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `记忆文件写入失败：${ioReason(error)}`,
    }
  }
}

/** 只在「确实不存在」时视作空内容；权限/目录等真实故障上抛给调用方判定。 */
async function readIfAbsent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // 有意与 loader.readOptionalFile 分道：注入路径对缺失容错、吞掉一切；
    // 这里编辑器/写入路径不得把「不可读」伪装成「空」，非缺失错误一律上抛。
    if (code === 'ENOENT' || code === 'ENOTDIR') return ''
    throw error
  }
}

function ioReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code) return code
  return error instanceof Error ? error.message : String(error)
}

/**
 * 定位（可能不存在的）指令文件并返回内容；无路径位置 → path null + 空内容。
 * 文件存在但不可读时向上抛错——由命令 handler 按内部错误映射，编辑器不得静默显示为空。
 */
export async function getInstruction(input: {
  store: Store
  scope: InstructionScope
  projectId: string | null
  kind: InstructionKind
}): Promise<{ path: string | null; content: string }> {
  const path = instructionPath(
    input.store,
    input.scope,
    input.kind,
    input.projectId,
  )
  if (path === null) return { path: null, content: '' }
  return { path, content: await readIfAbsent(path) }
}

/**
 * 指令页保存：与 remember 共用串行链（读-改-写互斥）。守卫失败返回 ok:false；
 * 真实磁盘故障沿链上抛（与 getInstruction 一致），由 handler 按内部错误处理。
 */
export function saveInstruction(input: {
  store: Store
  scope: InstructionScope
  projectId: string | null
  kind: InstructionKind
  content: string
}): Promise<{ ok: boolean; message: string }> {
  const task = writeChain.then(() => saveInstructionNow(input))
  // save 可能因磁盘故障 reject：catch 只保链不断，reject 仍原样交给本次调用方。
  writeChain = task.catch(() => undefined)
  return task
}

async function saveInstructionNow(input: {
  store: Store
  scope: InstructionScope
  projectId: string | null
  kind: InstructionKind
  content: string
}): Promise<{ ok: boolean; message: string }> {
  const path = instructionPath(
    input.store,
    input.scope,
    input.kind,
    input.projectId,
  )
  if (path === null) {
    return {
      ok: false,
      message: '目标文件路径无法解析（项目不存在或未设置文件夹）。',
    }
  }
  if (Buffer.byteLength(input.content, 'utf8') > MAX_SAVE_BYTES) {
    return { ok: false, message: `内容超过 ${MAX_SAVE_BYTES / 1024}KB 上限。` }
  }
  const normalized = input.content.replace(/\r\n/g, '\n')
  await mkdir(dirname(path), { recursive: true })
  await writeFileWithRename(path, normalized)
  return {
    ok: true,
    message: normalized.trim() === '' ? `已清空 ${path}。` : `已保存 ${path}。`,
  }
}

/** 临时文件 + rename 原子替换；失败清理半成品 tmp，随机后缀防同毫秒同名冲突。 */
async function writeFileWithRename(
  path: string,
  content: string,
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${suffix}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
```

**paths.ts 同步改动**：memory 分支抽成独立导出（`instructionPath` 的 memory 分支改为 `return memoryPath(store, scope, projectId)` 委托它，store 校验保留在 `memoryPath` 内，Task 1 测试断言不变）：

```ts
/**
 * MEMORY.md 路径：恒在应用数据目录（项目级隔离到 memories/<projectId>/）。
 * 项目不存在返回 null——projectId 必须过 store 校验，防任意字符串携 ../ 逃出数据目录。
 */
export function memoryPath(
  store: Store,
  scope: InstructionScope,
  projectId: string | null,
): string | null {
  const dataDir = resolveDataDir()
  if (scope === 'global') return join(dataDir, 'MEMORY.md')
  if (projectId === null) return null
  if (!store.projects.get(projectId)) return null
  return join(dataDir, 'memories', projectId, 'MEMORY.md')
}
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 格式与提交**

```bash
npx prettier --write apps/runtime/src/agent/instructions apps/runtime/test/instructions.test.mjs
git add apps/runtime/src/agent/instructions/ apps/runtime/test/instructions.test.mjs
git commit -m "feat(memory): remember/get/save 读写服务（串行写+机密拒绝+64KB 上限）"
```

---

### Task 4: 命令面 + 工具注册 + 注入接线

**Files:**

- Modify: `packages/contracts/src/commands.ts`（memory.list 块之后，commands.ts:424 附近）
- Create: `apps/runtime/src/agent/instructions/handlers.ts`
- Modify: `apps/runtime/src/handlers.ts:11,200`
- Create: `apps/runtime/src/agent/tools/instructions.ts`
- Modify: `apps/runtime/src/agent/tools/index.ts:96-109,77-94`
- Modify: `apps/runtime/src/agent/permissions.ts:36-44`
- Modify: `apps/runtime/src/agent/prompts/primary-agent.ts`
- Modify: `apps/runtime/src/agent/context.ts:14,206-211`
- Test: `apps/runtime/test/instructions.test.mjs`（追加）

- [ ] **Step 1: contracts 增加命令定义**

在 `packages/contracts/src/commands.ts` 的 `'memory.delete'` 定义之后（`'skill.list'` 之前）追加：

```ts
  'instructions.get': {
    // 指令页读取单个文件；path 为 null 表示当前条件下没有该文件位置。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
    }),
    result: z.object({
      path: z.string().nullable(),
      content: z.string(),
    }),
  },
  'instructions.save': {
    // 指令页保存（原子替换）；项目级 AGENTS.md 会写入用户仓库根。
    params: z.object({
      requestId: RequestIdSchema,
      scope: z.enum(['global', 'project']),
      projectId: z.string().min(1).optional(),
      kind: z.enum(['agents', 'memory']),
      content: z.string(),
    }),
    result: z.object({ ok: z.boolean(), message: z.string() }),
  },
```

- [ ] **Step 2: 重生成方法清单并跑覆盖测试确认失败**

```bash
node scripts/generate-runtime-methods.mjs
pnpm --filter @reflexion-os-studio/contracts build 2>/dev/null || pnpm build:packages
cd apps/runtime && npx tsc -p tsconfig.json && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/command-coverage.test.mjs
```

Expected: FAIL——`missing runtime handlers: instructions.get, instructions.save`。

- [ ] **Step 3: 写 handlers 并注册**

`apps/runtime/src/agent/instructions/handlers.ts`：

```ts
import { requireString, type CommandHandler } from '../../command-utils.js'
import { CommandError } from '../errors.js'
import { getInstruction, saveInstruction } from './service.js'
import type { InstructionKind, InstructionScope } from './paths.js'

function scopeOf(raw: unknown): InstructionScope {
  if (raw === 'global' || raw === 'project') return raw
  throw new CommandError('invalid_request', 'scope 必须是 global 或 project')
}

function kindOf(raw: unknown): InstructionKind {
  if (raw === 'agents' || raw === 'memory') return raw
  throw new CommandError('invalid_request', 'kind 必须是 agents 或 memory')
}

function projectIdOf(p: Record<string, unknown>): string | null {
  return typeof p.projectId === 'string' && p.projectId !== ''
    ? p.projectId
    : null
}

/** 指令页命令：四类文件的读取与保存（写路径均在 instructions/service.ts）。 */
export const instructionsCommandHandlers: Record<string, CommandHandler> = {
  'instructions.get': async (p, { store }) => {
    requireString(p, 'scope')
    // getInstruction 对「存在但不可读」的文件抛错：此处不吞，交由 dispatch 统一映射
    // （CommandError → 业务码；其余 → internal），编辑器不得把不可读当成空。
    return getInstruction({
      store,
      scope: scopeOf(p.scope),
      projectId: projectIdOf(p),
      kind: kindOf(p.kind),
    })
  },
  'instructions.save': async (p, { store }) => {
    requireString(p, 'scope')
    const outcome = await saveInstruction({
      store,
      scope: scopeOf(p.scope),
      projectId: projectIdOf(p),
      kind: kindOf(p.kind),
      content: typeof p.content === 'string' ? p.content : '',
    })
    if (!outcome.ok) throw new CommandError('invalid_request', outcome.message)
    return { ok: true, message: outcome.message }
  },
}
```

错误传播沿用 `agent/memory/handlers.ts` 的同一套映射：业务非法（scope/kind 不合法、`requireString` 缺参、save 的 `!ok` 守卫）抛 `CommandError`，dispatch 以自带 code 落 `-32000`；`getInstruction`/`saveInstruction` 对磁盘故障（不可读/写失败）抛的普通 `Error` 不在 handler 吞掉，原样上抛 → dispatch 归为 `internal`（见 `src/index.ts` 的 `catch`）。即 handler 只负责"业务判定"，读写服务的抛错语义由传输层兜底，二者共同保证编辑器不会把"读失败"误当"空文件"。

`apps/runtime/src/handlers.ts`：import 区加 `import { instructionsCommandHandlers } from './agent/instructions/handlers.js'`（与 memory 那行并列），合并表 `...memoryCommandHandlers,`（:200）后加 `...instructionsCommandHandlers,`。

- [ ] **Step 4: remember 工具与免审批接线**

`apps/runtime/src/agent/tools/instructions.ts`：

```ts
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import { remember } from '../instructions/service.js'
import { requireString, type ToolContext } from './shared.js'

/**
 * memory.remember（纯 TS 工具）：把稳定记忆追加进应用自管的 MEMORY.md。
 * 只写数据目录，不碰用户仓库里的 AGENTS.md；免审批（permissions 白名单），
 * 可感知性由工具轨迹卡承担。
 */
export function createMemoryRememberTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'memory.remember',
    description:
      '追加一条稳定的长期记忆到 MEMORY.md。适合：用户明确纠正/表达的稳定偏好、项目纪律与踩过的坑。只记结论不记流水账，≤200 字，禁止包含任何凭据；scope=global 为跨项目偏好，scope=project 为本项目纪律（会话需已关联项目）。写错内容会被拒绝并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        content: { type: 'string', description: '一句话、独立可读的记忆内容' },
      },
      required: ['scope', 'content'],
    },
    execute: async ({ args }) => {
      const scope = requireString(args, 'scope')
      if (scope !== 'global' && scope !== 'project') {
        return {
          content: 'scope 必须是 global 或 project。',
          isError: true,
          code: 'invalid_request',
        }
      }
      const content = requireString(args, 'content')
      const session = ctx.store.sessions.get(ctx.sessionId)
      const outcome = await remember({
        store: ctx.store,
        scope,
        content,
        projectId: session?.projectId ?? null,
      })
      return outcome.ok
        ? { content: outcome.message, isError: false }
        : { content: outcome.message, isError: true, code: outcome.code }
    },
  }
}
```

`apps/runtime/src/agent/tools/index.ts`：

- `alwaysAvailableTools` 数组中 `createSkillUseTool(ctx.skills),` 之后加 `createMemoryRememberTool(ctx),`；顶部 `import { createMemoryRememberTool } from './instructions.js'`。
- `BUILTIN_POLICIES` 加 `'memory.remember': STATE_POLICY,`（写数据目录文件，串行足够）。

`apps/runtime/src/agent/permissions.ts` 的 `AUTOMATIC_OTHER_TOOLS` 数组加：

```ts
  // 记忆只写数据目录内应用自管的 MEMORY.md，不触用户工作区，免审批。
  'memory.remember',
```

`apps/runtime/src/agent/prompts/primary-agent.ts` 在 Skill 那条约定（`'任务与"可用 Skills"…'` 行）之前插入一行：

```ts
  '当用户明确纠正你、表达稳定偏好，或协作中沉淀出项目纪律时，调用 memory.remember 记录：跨项目偏好记 global，本项目的规范与教训记 project；只记结论不记流水账，调用前确认不与已有记忆重复；用户说"记住 X"时必须调用。',
```

`apps/runtime/src/agent/context.ts`：

- :14 `import { buildMemoryBlock } from './memory/recall.js'` → `import { buildInstructionBlock } from './instructions/render.js'`
- :206-211 替换为：

```ts
// 指令/记忆文件注入（文件即记忆 V2）：失败/为空都不影响对话。
const instructionBlock = await buildInstructionBlock(
  this.store,
  sessionId,
).catch(() => '')
const effectiveSystem =
  instructionBlock === ''
    ? systemPrompt
    : `${systemPrompt}\n\n${instructionBlock}`
```

- [ ] **Step 5: 追加接线测试并跑全 runtime 测试**

`instructions.test.mjs` 追加（顶部补 `import { commandHandlers } from '../dist/handlers.js'`、`import { PermissionGate } from '../dist/agent/permissions.js'`、`import { PRIMARY_AGENT_SYSTEM_PROMPT } from '../dist/agent/prompts/index.js'`）：

```js
test('接线：instructions 命令有 handler、remember 工具免审批、prompt 有约定', () => {
  assert.ok(commandHandlers['instructions.get'])
  assert.ok(commandHandlers['instructions.save'])
  const gate = new PermissionGate('workspace', false)
  assert.equal(gate.decisionFor('memory.remember'), 'automatic')
  assert.ok(PRIMARY_AGENT_SYSTEM_PROMPT.includes('memory.remember'))
})

test('instructions.get/save 经 handler 往返', async () => {
  const store = freshStore()
  const ctx = { store }
  const saved = await commandHandlers['instructions.save'](
    {
      scope: 'global',
      kind: 'memory',
      content: '# 记忆\n\n## 记忆条目\n- 2026-09-12 手写条目',
    },
    ctx,
  )
  assert.equal(saved.ok, true)
  const got = await commandHandlers['instructions.get'](
    { scope: 'global', kind: 'memory' },
    ctx,
  )
  assert.ok(got.content.includes('手写条目'))
})
```

（`requireString` 的 requestId 由 dispatch 层剥离，handler 直调测试不传。）

> Task 4 审查项落地（与 shipped 同步）：execute 层非法 scope 显式拒绝（不回落 global），并追加 5 个 execute/装配用例（valid global、无项目 project → no_project、'Project' 笔误 → invalid_request 且全局 MEMORY.md 不落盘、项目会话 project → memories/<id>、`createToolRegistry` 含 memory.remember）与 1 个"注入与命令面读同一真相源"集成钉（`instructions.test.mjs`）。

Run（workdir `apps/runtime`）: `npx tsc -p tsconfig.json && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/instructions.test.mjs test/command-coverage.test.mjs test/permissions.test.mjs test/runner.test.mjs`
Expected: 全 PASS（memory.test.mjs 仍独立绿——旧管线未拆）。

- [ ] **Step 6: 全链快验 + 提交**

```bash
pnpm typecheck && pnpm --filter @reflexion-os-studio/desktop typecheck
git add packages/contracts/src/commands.ts packages/contracts/generated/runtime-methods.json apps/runtime/src/agent/instructions/handlers.ts apps/runtime/src/handlers.ts apps/runtime/src/agent/tools/instructions.ts apps/runtime/src/agent/tools/index.ts apps/runtime/src/agent/permissions.ts apps/runtime/src/agent/prompts/primary-agent.ts apps/runtime/src/agent/context.ts apps/runtime/test/instructions.test.mjs
git commit -m "feat(memory): instructions 命令面 + memory.remember 工具 + 四层文件注入接线"
```

---

### Task 5: 删除 SQLite 记忆链路（runtime + 存储 + 契约 + 前端旧接线）

**Files:**

- Delete: `apps/runtime/src/agent/memory/`（10 文件）、`apps/runtime/src/agent/prompts/memory-extractor.ts`、`memory-merger.ts`、`apps/runtime/src/store/memories.ts`、`memoryJobs.ts`、`apps/runtime/test/memory.test.mjs`、`memory-job.test.mjs`、`apps/desktop/frontend/api/memory.ts`、`apps/desktop/frontend/features/memories/`
- Modify: `apps/runtime/src/agent/index.ts`、`launcher.ts`、`runner.ts`、`run-finalizer.ts`、`handlers.ts`、`prompts/index.ts`、`store/schema.ts`、`store/migrations.ts`、`store/index.ts`、`apps/runtime/package.json`、`packages/contracts/src/{entities,commands,events}.ts`、`packages/runtime-client/src/index.ts`、前端 `App.tsx`、`AppMain.tsx`、`Sidebar.tsx`、`TopBar.tsx`、`main.tsx`、`useAppBootstrap.ts`、`useSessionNavigation.ts`

- [ ] **Step 1: runtime 装配层摘线**

`agent/index.ts`：删 :15-16 import、:35-36 字段、:48-49 构造、:58 `memory: this.memory,`、:63 `onMemoryJob: …`、:250-251 抢占两行（含注释）。
`agent/launcher.ts`：删 :19 import、`LaunchDeps.memory`（:64）、`LaunchOptions.onMemoryJob`（:53-54）、`LaunchHooks.onMemoryJob`（:71-72）、:183 `onMemoryJob: input.onMemoryJob,`。
`agent/runner.ts`：删 :35-36 `onMemoryJob` 注释与字段、:135-137 触发块、各 decision 里 `enqueueMemoryJob: true/false,` 行（:234,248,262,271,282,301）。
`agent/run-finalizer.ts`：删 `RunTerminalDecision.enqueueMemoryJob` 字段（:22）、:72-74 `this.store.memoryJobs.enqueue(run.id)` 所在 if 块。
`agent/handlers.ts`（即 `src/handlers.ts`）：删 :11 `import { memoryCommandHandlers } …` 与 :200 `...memoryCommandHandlers,`。
`agent/prompts/index.ts`：删 :3-4 两个 MEMORY_* 导出。
`store/index.ts`：删 :22 import、:48 类型、:77 构造、:93 `this.memoryJobs.recoverRunning()`、以及 `memories` 同四件套（grep `memories` 定位）。

- [ ] **Step 2: schema v23 迁移（删表）**

`store/schema.ts`：删 `CREATE TABLE IF NOT EXISTS memories …` 至 memories_fts 三个 trigger 的整块（:115-149）与 `memory_jobs` 表 + 索引块（:239-250）；`LATEST_SCHEMA_VERSION` 22→23。
`store/migrations.ts` 在 `if (version < 22) {…}` 后追加：

```ts
// v23（文件即记忆 V2）：删除 SQLite 记忆链路。存量 memories/FTS/
// memory_jobs 按用户决策整体 drop——记忆真相源迁移为 MEMORY.md 文件，
// 不做数据搬迁（自动提取的记忆本来就不具备保留价值）。
if (version < 23) {
  db.exec('DROP TABLE IF EXISTS memories_fts')
  db.exec('DROP TABLE IF EXISTS memories')
  db.exec('DROP TABLE IF EXISTS memory_jobs')
}
```

- [ ] **Step 3: 删除文件**

```bash
git rm -r apps/runtime/src/agent/memory apps/runtime/src/agent/prompts/memory-extractor.ts apps/runtime/src/agent/prompts/memory-merger.ts apps/runtime/src/store/memories.ts apps/runtime/src/store/memoryJobs.ts apps/runtime/test/memory.test.mjs apps/runtime/test/memory-job.test.mjs apps/desktop/frontend/api/memory.ts apps/desktop/frontend/features/memories
```

`apps/runtime/package.json` test script 字符串里删 `test/memory.test.mjs ` 与 `test/memory-job.test.mjs `。

- [ ] **Step 4: contracts + runtime-client 清理**

`packages/contracts/src/entities.ts`：删 :355-401 的 Memory 系列 schema/type。
`packages/contracts/src/commands.ts`：删 `memory.list/update/delete` 三块及顶部 `MemoryScopeSchema, MemorySchema, MemoryStatusSchema` import。
`packages/contracts/src/events.ts`：删 :143-147 `memory.written` 与 `MemorySchema` import。
`packages/runtime-client/src/index.ts`：删 `Memory,`（:8）及若有 `MemoryScope/MemoryKind` 再导出。
重跑 `node scripts/generate-runtime-methods.mjs`。

- [ ] **Step 5: 前端旧接线拆除**

- `useAppBootstrap.ts`：删 `showMemoryNotice` 输入声明（:65）、返回类型 `memoryNotice`（:85）、state/timer/callback 块（:107-116）、两处 latest-ref 集合中的 `showMemoryNotice,`（:183,:197,:227）、`memory.written` 事件分支（:329-334 含注释）、卸载清理 `memoryNoticeTimer` 行（:382）、返回值 `memoryNotice,`（:400）。
- `App.tsx`：删解构处 `memoryNotice,`（:181）、topBar 组 `memoryNotice,`（:404）、`memories={{ confirm }}`（:460）。
- `TopBar.tsx`：删 props `memoryNotice: string | null`（:22）与 badge 块（:55-57）。
- `Sidebar.tsx`：view union 删 `'memories'`（:17）、删 NavItem"记忆"块（:192-197）。
- `useSessionNavigation.ts`：union 删 `'memories'`（:7）。
- `AppMain.tsx`：删 `MemoryView` import（:6）、`memories` prop 类型（:29）、contextTitle 分支 `view === 'memories' ? '记忆'`（:50）、渲染分支 `view === 'memories' ? <MemoryView …/>`（:87）。
- `main.tsx`：删 `import './features/memories/memory.css'`（:9）。

- [ ] **Step 6: 残留引用清零验证**

```bash
grep -rn "memoryJobs\|MemorySchema\|memory.written\|memory\.list\|memory\.update\|memory\.delete\|MemoryView\|buildMemoryBlock\|memoryNotice\|listMemories\|store\.memories" apps packages --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v node_modules | grep -v dist/ | grep -v memory.remember
```

Expected: 0 行输出。

```bash
pnpm typecheck && pnpm --filter @reflexion-os-studio/desktop typecheck
cd apps/runtime && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/*.test.mjs
```

Expected: typecheck 全绿；runtime 测试全 PASS（instructions/context-budget/runner/command-coverage 重点看）。

- [ ] **Step 7: 提交**

```bash
git add -A apps packages
git commit -m "refactor(memory)!: 删除 SQLite 自动记忆链路（提取/合并/召回/worker/表/页面），真相源迁移到指令文件"
```

---

### Task 6: 前端"指令"页

**Files:**

- Create: `apps/desktop/frontend/api/instructions.ts`
- Create: `apps/desktop/frontend/features/instructions/InstructionsView.tsx`
- Create: `apps/desktop/frontend/features/instructions/instructions.css`
- Modify: `AppMain.tsx`、`Sidebar.tsx`、`useSessionNavigation.ts`、`App.tsx`、`main.tsx`

- [ ] **Step 1: api 封装**

`apps/desktop/frontend/api/instructions.ts`：

```ts
import { request } from './client'

export interface InstructionFile {
  path: string | null
  content: string
}

export function getInstruction(input: {
  scope: 'global' | 'project'
  projectId?: string
  kind: 'agents' | 'memory'
}): Promise<InstructionFile> {
  return request<InstructionFile>('instructions.get', input)
}

export function saveInstruction(input: {
  scope: 'global' | 'project'
  projectId?: string
  kind: 'agents' | 'memory'
  content: string
}): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('instructions.save', input)
}
```

- [ ] **Step 2: 视图组件**

`apps/desktop/frontend/features/instructions/InstructionsView.tsx`：实现已合入（以代码为准，见 66e2695 与其后的守卫修复提交），此处只记录审查后定稿的关键设计：

- 所有 `getInstruction / saveInstruction / listProjects` 链都带 `.catch`：错误上各 pane 状态行（红色），读失败清空并禁用编辑区，绝不静默留白或留旧内容；
- 脏草稿守卫（三键守卫同款仓库模式）：`InstructionPane` 经 `onDirtyChange(kind, dirty)` 把脏态上抛，父级 `Record<Kind, boolean>` 聚合；pane 卸载 cleanup 报 `false`（key 含 scope/project，重挂载不残留脏计数）。凡会丢弃草稿的动作（重新读取、scope 切换、项目选择）统一走守卫：

  ```tsx
  const guarded = (action: () => void, onCancel?: () => void): void => {
    if (!anyDirty) {
      action()
      return
    }
    void (async () => {
      const ok = await props.confirm({
        title: '有未保存的修改',
        message:
          '继续将重新读取文件并丢弃未保存的修改，建议先点「保存」。确定丢弃并继续？',
        confirmLabel: '丢弃并继续',
      })
      if (ok) action()
      else onCancel?.()
    })()
  }
  ```

- 保存按钮 `!dirty || path === null || saving || loading` 任一即禁用；任一 pane 保存中禁用「重新读取」（`onSavingChange` 上抛，防 get 与在途写盘竞态）；select 取消时经 ref 回弹 DOM value（受控值未变 React 不写回）；scope 按钮 `aria-pressed`、select/textarea `aria-label`。

- [ ] **Step 3: 样式 + 接线**

`apps/desktop/frontend/features/instructions/instructions.css`（沿用项目既有卡片观感，变量不新增）：

```css
.instructions-view {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}
.instructions-view header h2 {
  margin: 0 0 4px;
}
.instructions-view header p {
  margin: 0 0 16px;
  color: var(--text-dim, #8a8f98);
}
.instructions-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}
.instructions-toolbar select {
  margin-left: 4px;
}
.instructions-disabled {
  opacity: 0.55;
  pointer-events: none;
}
.instruction-pane {
  border: 1px solid var(--border, #2c2f36);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
}
.instruction-pane h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
.instruction-path,
.instruction-hint {
  margin: 2px 0;
  font-size: 12px;
  color: var(--text-dim, #8a8f98);
  word-break: break-all;
}
.instruction-pane textarea {
  width: 100%;
  margin-top: 10px;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  resize: vertical;
}
.instruction-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
.instruction-dirty {
  color: #d9a441;
  font-size: 12px;
}
.instruction-status {
  color: var(--text-dim, #8a8f98);
  font-size: 12px;
  word-break: break-all;
}
```

接线（对称于 Task 5 删除处）：

- `useSessionNavigation.ts` / `Sidebar.tsx` view union 加 `'instructions'`；Sidebar 原"记忆"位置加 NavItem：`label="指令"`、`active={props.view === 'instructions'}`、`onClick={() => props.onSelectView('instructions')}`（图标沿用 `ArchiveIcon`）。
- `AppMain.tsx`：import `InstructionsView`；contextTitle 分支 `view === 'instructions' ? '指令'`；渲染分支 `<InstructionsView {...props.instructions} />`；`AppMainProps` 新增最小分组 `instructions: ComponentProps<typeof InstructionsView>`（脏草稿守卫需要 confirm 弹窗句柄）。
- `main.tsx`：加 `import './features/instructions/instructions.css'`（原 memories.css 位置）。
- `App.tsx`：`memories={{ confirm }}` 处已删；新增 `instructions={{ confirm }}`（复用 useConfirmDialog 的 `confirm`）。

- [ ] **Step 4: 验证**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm build:packages
cd apps/runtime && node --disable-warning=ExperimentalWarning --import ./test/set-test-data-dir.mjs --test test/*.test.mjs
```

Expected: 全绿。手工冒烟：`pnpm dev` → 指令页看到全局两文件（空）→ 项目 tab 选 reflexion-os-studio → 项目 AGENTS.md 显示本仓库真实内容 → 对话中发"记住：本产品文案默认中文" → 工具卡出现 memory.remember 结果 → 页面重新读取后全局 MEMORY.md 有该条 → 新会话提问验证注入生效。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/frontend apps/runtime
git commit -m "feat(memory): 指令页（全局/项目 × AGENTS.md/MEMORY.md 查看编辑）"
```

---

### Task 7: 文档同步与全链验收

**Files:**

- Modify: `docs/MEMORY-SYSTEM.md`（整体改写）、`AGENTS.md`（§1/§2/§4）、`docs/ROADMAP.md`
- 无代码改动

- [ ] **Step 1: MEMORY-SYSTEM.md 改写**

保留文件头，正文替换为：四层模型（Working/Session 归上下文引擎，一句带过）→ 文件即记忆 V2（指向本 spec 路径）→ 三层表格（指令/记忆/原始事实，spec §3 原样）→ remember 语义与信任模型（免审批、机密过滤、64KB 上限）→ 注入顺序与预算 → 生命周期（人工整理，无自动治理）→ 演进承诺（需要检索式召回时整体引入 mem0，不自研）。删除全部"提取→合并→召回→pinned/FTS/embedding"的旧描述。

- [ ] **Step 2: AGENTS.md 同步**

- §1 能力清单：Memory 行改为「**Memory V2（文件即记忆）**：全局/项目 AGENTS.md + MEMORY.md 四层注入、memory.remember 免审批工具、指令页管理；SQLite 自动提取链路已删除（v23 迁移），未来检索直引 mem0」。
- §2 依赖方向表下"Runtime 命令与域目录"条目（§4）：`agent/memory/handlers.ts` 改为 `agent/instructions/handlers.ts`。
- §4 存储条目：删除"记忆"相关表述若有；`store/` 分文件示例不含 memories。

- [ ] **Step 3: ROADMAP.md 记录**

Phase 2 段落追加一行：Memory V2（文件即记忆）已完成，自动提取链路移除；检索式记忆（mem0 集成）列为候选后续项。

- [ ] **Step 4: 全链验证（AGENTS.md §6 顺序）**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm build:packages
cargo fmt --manifest-path crates/Cargo.toml -- --check && cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: 全绿（Rust 侧零改动，属回归兜底）。性能抽查：`pnpm dev` 空闲 30s，`top -l 4 -s 3 -stats pid,cpu,mem` 三进程 CPU ≈0%（本改动删除了 Run 尾后台 LLM 调用，空闲负载只降不升）。

- [ ] **Step 5: 提交**

```bash
git add docs/MEMORY-SYSTEM.md AGENTS.md docs/ROADMAP.md
git commit -m "docs: Memory V2（文件即记忆）文档同步：MEMORY-SYSTEM 改写 + AGENTS/ROADMAP 更新"
```

---

## 风险与回滚

- **不可逆点**：Task 5 的 v23 迁移会 drop `memories`/`memory_jobs`——用户已明确决策"全删"。若实施中途要回退，必须在迁移合入前回滚；合入后回退需从备份库导出。
- 工作区不干净导致误 stage：所有提交步骤都显式列文件，禁止 `git add .`；Task 5 Step 7 的 `git add -A apps packages` 仅在该任务的删除语境下使用，执行前 `git status --short` 确认无外来源文件。
- 前端视图 union 三处（Sidebar/useSessionNavigation/AppMain）改名不同步会在 typecheck 暴露，Task 5/6 各自带 typecheck。
