import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Store } from '../../store/index.js'
import { resolveDataDir } from '../../store/shared.js'
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

/** 项目删除后清理其记忆目录；失败不阻塞删除本身（孤儿目录由启动清扫兜底）。 */
export async function deleteProjectMemoryDir(projectId: string): Promise<void> {
  try {
    await rm(join(resolveDataDir(), 'memories', projectId), {
      recursive: true,
      force: true,
    })
  } catch (error) {
    process.stderr.write(
      `[runtime] memory dir cleanup failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/**
 * 启动清扫（与 Asset recover 同构语义）：删除 <dataDir>/memories/ 下
 * 无项目行对应的孤儿目录（project.delete 行删成功但目录清理失败/中断的
 * 残留）；单个目录删除失败只记 stderr，下次启动再试。
 */
export async function sweepOrphanMemoryDirs(store: Store): Promise<void> {
  const root = join(resolveDataDir(), 'memories')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (store.projects.get(entry.name)) continue
    try {
      await rm(join(root, entry.name), { recursive: true, force: true })
    } catch (error) {
      process.stderr.write(
        `[runtime] orphan memory dir cleanup failed (${entry.name}): ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
}
