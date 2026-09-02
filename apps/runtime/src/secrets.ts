import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { CommandError } from './agent/errors.js'
import { resolveDataDir } from './store/index.js'

const IS_WINDOWS = process.platform === 'win32'

interface SecretFile {
  [secretRef: string]: string
}

/**
 * 密钥库稳定错误：读/写失败统一抛出此类，携带稳定 code 供协议层映射；
 * message 恒定、不携带任何密钥明文或文件内容，避免泄漏。
 */
export class SecretStoreError extends CommandError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'SecretStoreError'
  }
}

/**
 * 单个密钥文件的原子读写封装，构造时注入数据目录以便测试。
 *
 * 写入流程：同目录临时文件 → 写入 + fsync → chmod 0600（仅 POSIX）→ 原子 rename。
 * rename 与目标同目录，保证同文件系统内原子替换；崩溃不会留下半写的主文件。
 */
export class SecretStore {
  constructor(private readonly dir: string) {}

  private path(): string {
    return join(this.dir, 'secrets.json')
  }

  save(secretRef: string, value: string): void {
    const secrets = this.read()
    secrets[secretRef] = value
    this.write(secrets)
  }

  load(secretRef: string): string | undefined {
    return this.read()[secretRef]
  }

  /** 删除指定引用的密钥；引用不存在时返回 false。 */
  delete(secretRef: string): boolean {
    const secrets = this.read()
    if (!(secretRef in secrets)) return false
    delete secrets[secretRef]
    this.write(secrets)
    return true
  }

  private read(): SecretFile {
    const path = this.path()
    if (!existsSync(path)) return {}
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      // 文件系统错误（权限、IO 等），不含密钥明文。
      throw new SecretStoreError(
        'secrets_read_failed',
        `密钥文件读取失败: ${String(error)}`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 稳定错误：不把损坏内容/可能的明文拼进 message。
      throw new SecretStoreError(
        'secrets_corrupted',
        '密钥文件损坏或格式非法，拒绝读取',
      )
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== 'string')
    ) {
      throw new SecretStoreError(
        'secrets_corrupted',
        '密钥文件损坏或格式非法，拒绝读取',
      )
    }
    return parsed as SecretFile
  }

  private write(secrets: SecretFile): void {
    mkdirSync(this.dir, { recursive: true })
    const path = this.path()
    // 唯一临时文件：并发写入不互相踩踏，rename 前崩溃只残留 .tmp。
    const tmpPath = join(
      this.dir,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const content = `${JSON.stringify(secrets, null, 2)}\n`
    const fd = openSync(tmpPath, 'w', 0o600)
    try {
      writeFileSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!IS_WINDOWS) {
      // POSIX：显式 chmod 绕过 umask，确保最终文件权限恒为 0600。
      chmodSync(tmpPath, 0o600)
    }
    // 平台差异收敛在本模块：Windows 上不调用 chmod（NTFS 无 POSIX 权限语义），
    // rename 用 MoveFileEx(REPLACE_EXISTING) 同样原子。
    renameSync(tmpPath, path)
    // 目录 fsync 确保改名/元数据落盘；仅 POSIX 支持以读模式打开目录句柄。
    if (!IS_WINDOWS) {
      try {
        const dfd = openSync(this.dir, 'r')
        try {
          fsyncSync(dfd)
        } finally {
          closeSync(dfd)
        }
      } catch {
        // 部分平台/文件系统不支持目录 fsync：数据本身已 fsync，忽略。
      }
    }
  }
}

// 默认单例：复用 runtime 数据目录，保持既有模块级 API 不变。
const defaultStore = new SecretStore(resolveDataDir())

export function saveSecret(value: string): string {
  const secretRef = `local:${randomUUID()}`
  defaultStore.save(secretRef, value)
  return secretRef
}

export function loadSecret(secretRef: string): string | undefined {
  return defaultStore.load(secretRef)
}

/** 删除指定引用的密钥；引用不存在时静默成功。 */
export function deleteSecret(secretRef: string): void {
  defaultStore.delete(secretRef)
}
