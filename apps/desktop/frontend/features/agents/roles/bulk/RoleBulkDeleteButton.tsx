import { useState } from 'react'
import type {
  AgentTemplate,
  AgentTemplateBulkRemoveParams,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../../../components/ConfirmDialog'

export function RoleBulkDeleteButton({
  roles,
  busy,
  confirm,
  onDelete,
}: {
  roles: AgentTemplate[]
  busy: boolean
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  onDelete: (
    input: Omit<AgentTemplateBulkRemoveParams, 'requestId'>,
  ) => Promise<boolean>
}) {
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      className="dialog-danger"
      disabled={
        busy ||
        pending ||
        !roles.length ||
        roles.length > 500 ||
        roles.some((role) => role.builtin)
      }
      onClick={async () => {
        if (pending) return
        setPending(true)
        const targets = roles.map(({ id, updatedAt }) => ({ id, updatedAt }))
        try {
          if (
            await confirm({
              title: `删除 ${roles.length} 个角色`,
              message: `将删除以下角色：\n${roles.map((role) => role.name).join('、')}\n已有执行记录和关联技能会保留；删除后无法撤销。`,
              confirmLabel: `删除 ${roles.length} 个角色`,
              danger: true,
            })
          )
            await onDelete({ targets })
        } finally {
          setPending(false)
        }
      }}
    >
      批量删除
    </button>
  )
}
