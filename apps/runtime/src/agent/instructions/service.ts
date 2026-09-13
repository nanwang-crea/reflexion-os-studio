import {
  appendFile,
  mkdir,
  readFile,
  rename,
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
export const MAX_MEMORY_FILE_BYTES = 64 * 1024
/** 指令页保存的内容上限（AGENTS.md 允许更大，用户在编辑器里写长文）。 */
const MAX_SAVE_BYTES = 256 * 1024

/** remember 工具与手动写入共用一条进程内串行链，避免并发 Run 交错。 */
let writeChain: Promise<unknown> = Promise.resolve()

export interface RememberOutcome {
  ok: boolean
  code?: 'no_project' | 'too_long' | 'secret_like' | 'too_large'
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
  // rememberNow 内部不抛错（全部折叠为 outcome）；catch 仅保链不断。
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
  const existing = await readIfAbsent(path)
  if (Buffer.byteLength(existing, 'utf8') > MAX_MEMORY_FILE_BYTES) {
    return {
      ok: false,
      code: 'too_large',
      message: `记忆文件已超 ${MAX_MEMORY_FILE_BYTES / 1024}KB 上限，请到指令页整理既有条目。`,
    }
  }
  const entry = `- ${new Date().toISOString().slice(0, 10)} ${content}`
  await mkdir(dirname(path), { recursive: true })
  const body =
    existing === '' ? `${MEMORY_FILE_HEADER}\n${entry}\n` : `${entry}\n`
  await appendFile(path, body, 'utf8')
  return {
    ok: true,
    message: `已记住（${path}）：${content}`,
    path,
    entry,
  }
}

async function readIfAbsent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** 定位（可能不存在的）指令文件并返回内容；无路径位置 → path null + 空内容。 */
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

/** 指令页保存：临时文件 + rename 原子替换；UTF-8 无 BOM、\n 换行。 */
export async function saveInstruction(input: {
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

async function writeFileWithRename(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}
