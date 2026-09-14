import { readFile } from 'node:fs/promises'

/** 指令文件缺失/不可读都视为「没有这层上下文」，返回空串而不是抛错。 */
export async function readOptionalFile(path: string | null): Promise<string> {
  if (path === null) return ''
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
