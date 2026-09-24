import type { PermissionPreset } from '@reflexion-os-studio/runtime-client'

/**
 * 权限预设的 localStorage 读写（纯函数便于单测；React hook 只做装配）。
 * V2 key 承载三档；旧 key（workspace / read-only / trusted 双轨）一次性迁移，
 * 一切未知/异常都保守回落 workspace-read（升级不静默扩大写权限）。
 */

export const PRESET_STORAGE_KEY = 'reflexion.permission-preset.v2'
/** @deprecated 旧版 key；仅用于一次性迁移。 */
export const LEGACY_PRESET_STORAGE_KEY = 'reflexion.permission-mode'

const VALUES: PermissionPreset[] = [
  'workspace-read',
  'workspace-write',
  'workspace-full',
]

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (VALUES as string[]).includes(value)
}

export function migratePreset(
  v2Value: string | null,
  legacyValue: string | null,
): PermissionPreset {
  if (isPermissionPreset(v2Value)) return v2Value
  // 设计裁定：legacy workspace / read-only 都收敛为 workspace-read；
  // trusted 从不持久化，无迁移数据。
  void legacyValue
  return 'workspace-read'
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function loadPreset(storage: StorageLike | null): PermissionPreset {
  if (storage === null) return 'workspace-read'
  try {
    const stored = storage.getItem(PRESET_STORAGE_KEY)
    const legacy = storage.getItem(LEGACY_PRESET_STORAGE_KEY)
    const preset = migratePreset(stored, legacy)
    storage.setItem(PRESET_STORAGE_KEY, preset)
    if (legacy !== null) storage.removeItem(LEGACY_PRESET_STORAGE_KEY)
    return preset
  } catch {
    return 'workspace-read'
  }
}

export function savePreset(
  storage: StorageLike | null,
  preset: PermissionPreset,
): void {
  if (storage === null) return
  try {
    storage.setItem(PRESET_STORAGE_KEY, preset)
  } catch {
    // 写不进偏好不影响功能：档位快照仍随每次 message.send 下发。
  }
}
