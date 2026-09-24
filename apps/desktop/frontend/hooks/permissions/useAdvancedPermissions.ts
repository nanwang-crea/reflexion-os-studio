import { useCallback, useEffect, useState } from 'react'
import type { ApprovalOverride } from '@reflexion-os-studio/runtime-client'
import {
  dangerDisable,
  getApprovalOverride,
  setApprovalOverride,
} from '../../api/permissions'
import { useDangerLease } from './useDangerLease'

/**
 * 高级权限入口的应用级状态：ask-everything 覆盖项（按会话对账 Runtime）、
 * Danger 租约投影与两段确认对话框开关。权限真源全部在 Runtime，这里只是
 * UI 投影与命令派发。
 */
export function useAdvancedPermissions(
  activeSessionId: string | null,
  setNotice: (notice: string | null) => void,
): {
  approvalOverride: ApprovalOverride
  changeApprovalOverride: (value: ApprovalOverride) => void
  dangerLease: ReturnType<typeof useDangerLease>['lease']
  onDangerChanged: ReturnType<typeof useDangerLease>['onDangerChanged']
  disableDanger: () => void
  dangerDialogOpen: boolean
  setDangerDialogOpen: (open: boolean) => void
} {
  const { lease: dangerLease, onDangerChanged } =
    useDangerLease(activeSessionId)
  const [dangerDialogOpen, setDangerDialogOpen] = useState(false)
  const [approvalOverride, setApprovalOverrideValue] =
    useState<ApprovalOverride>('default')

  useEffect(() => {
    // 覆盖项按会话存于 Runtime：切换会话时对账（失败回落 default，只会更严）。
    if (activeSessionId === null) {
      setApprovalOverrideValue('default')
      return
    }
    let cancelled = false
    void getApprovalOverride(activeSessionId)
      .then((result) => {
        if (!cancelled) setApprovalOverrideValue(result.override)
      })
      .catch(() => {
        if (!cancelled) setApprovalOverrideValue('default')
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  const changeApprovalOverride = useCallback(
    (value: ApprovalOverride): void => {
      if (activeSessionId === null) return
      setApprovalOverrideValue(value)
      void setApprovalOverride(activeSessionId, value)
        .then((result) => setApprovalOverrideValue(result.override))
        .catch((error: unknown) => {
          setApprovalOverrideValue('default')
          setNotice(error instanceof Error ? error.message : String(error))
        })
    },
    [activeSessionId, setNotice],
  )

  const disableDanger = useCallback((): void => {
    if (activeSessionId === null) return
    void dangerDisable(activeSessionId).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error))
    })
  }, [activeSessionId, setNotice])

  return {
    approvalOverride,
    changeApprovalOverride,
    dangerLease,
    onDangerChanged,
    disableDanger,
    dangerDialogOpen,
    setDangerDialogOpen,
  }
}
