import { useCallback, useState } from 'react'

const PERMISSION_STORAGE_KEY = 'reflexion.permission-mode'
const VALID_MODES = ['workspace', 'read-only']

function initialMode(): string {
  const stored = localStorage.getItem(PERMISSION_STORAGE_KEY)
  return stored !== null && VALID_MODES.includes(stored) ? stored : 'workspace'
}

/** 工具权限 Profile 偏好（workspace / read-only）；持久化在 localStorage。 */
export function usePermissionMode(): {
  permissionMode: string
  changePermissionMode: (value: string) => void
} {
  const [permissionMode, setPermissionMode] = useState<string>(initialMode)
  const changePermissionMode = useCallback((value: string): void => {
    setPermissionMode(value)
    localStorage.setItem(PERMISSION_STORAGE_KEY, value)
  }, [])
  return { permissionMode, changePermissionMode }
}
