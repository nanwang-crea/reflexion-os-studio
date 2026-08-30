import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './store.js'

interface SecretFile {
  [secretRef: string]: string
}

function secretsPath(): string {
  return join(resolveDataDir(), 'secrets.json')
}

function readSecrets(): SecretFile {
  const path = secretsPath()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as SecretFile
}

function writeSecrets(secrets: SecretFile): void {
  const path = secretsPath()
  mkdirSync(resolveDataDir(), { recursive: true })
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function saveSecret(value: string): string {
  const secretRef = `local:${randomUUID()}`
  const secrets = readSecrets()
  secrets[secretRef] = value
  writeSecrets(secrets)
  return secretRef
}

export function loadSecret(secretRef: string): string | undefined {
  return readSecrets()[secretRef]
}

/** 删除指定引用的密钥；引用不存在时静默成功。 */
export function deleteSecret(secretRef: string): void {
  const secrets = readSecrets()
  if (!(secretRef in secrets)) return
  delete secrets[secretRef]
  writeSecrets(secrets)
}
