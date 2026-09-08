import { useCallback, useState } from 'react'

const PERMISSION_STORAGE_KEY = 'reflexion.permission-mode'

/** Composer 权限下拉的取值：workspace / read-only 持久化，trusted 仅内存态。 */
export type PermissionModeValue = 'workspace' | 'read-only' | 'trusted'

function initialMode(): PermissionModeValue {
  // trusted（本会话完全允许）不持久化：存储里只会出现前两档，回落 workspace。
  return localStorage.getItem(PERMISSION_STORAGE_KEY) === 'read-only'
    ? 'read-only'
    : 'workspace'
}

/**
 * 工具权限模式偏好：workspace（工作区读写）/ read-only（只读）持久化在
 * localStorage；trusted（完全允许）为会话级内存态，不持久化。
 */
export function usePermissionMode(): {
  permissionMode: PermissionModeValue
  changePermissionMode: (value: PermissionModeValue) => void
} {
  const [permissionMode, setPermissionMode] =
    useState<PermissionModeValue>(initialMode)
  const changePermissionMode = useCallback(
    (value: PermissionModeValue): void => {
      setPermissionMode(value)
      if (value === 'trusted') {
        localStorage.removeItem(PERMISSION_STORAGE_KEY)
      } else {
        localStorage.setItem(PERMISSION_STORAGE_KEY, value)
      }
    },
    [],
  )
  return { permissionMode, changePermissionMode }
}
