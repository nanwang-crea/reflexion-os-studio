import { useCallback, useState } from 'react'
import type { PermissionPreset } from '@reflexion-os-studio/runtime-client'
import {
  isPermissionPreset,
  loadPreset,
  savePreset,
} from './permission-storage'

/**
 * 三档日常权限预设偏好（持久化，key/迁移见 permission-storage）。
 * Danger 与 ask-everything 属高级项：前者是 Runtime 租约（唯一真源在内存），
 * 后者按会话存 Runtime，均不落 localStorage。
 */
export function usePermissionPreset(): {
  permissionPreset: PermissionPreset
  changePermissionPreset: (value: PermissionPreset) => void
} {
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>(
    () => loadPreset(localStorageOrNull()),
  )
  const changePermissionPreset = useCallback((value: PermissionPreset) => {
    if (!isPermissionPreset(value)) return
    setPermissionPreset(value)
    savePreset(localStorageOrNull(), value)
  }, [])
  return { permissionPreset, changePermissionPreset }
}

function localStorageOrNull(): Storage | null {
  try {
    return localStorage
  } catch {
    // 隐私模式等场景 localStorage 直接抛错：保持内存态。
    return null
  }
}

export const PERMISSION_PRESET_LABELS: Record<PermissionPreset, string> = {
  'workspace-read': '谨慎模式（推荐）',
  'workspace-write': '工作区读写',
  'workspace-full': '工作区完全允许',
}
export const PERMISSION_PRESET_HINTS: Record<PermissionPreset, string> = {
  'workspace-read':
    '读取自动放行；写入、删除与命令执行逐次询问。工作区外访问需显式提权。',
  'workspace-write':
    '读取与写入自动放行；删除与命令执行逐次询问。仅限工作区内。',
  'workspace-full':
    '工作区内操作自动放行（仍在沙箱内执行）；删除不弹卡；工作区外仍需提权，网络仍需审批。',
}
