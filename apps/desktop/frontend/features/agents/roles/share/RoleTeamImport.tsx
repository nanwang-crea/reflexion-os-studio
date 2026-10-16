import { useState } from 'react'
import type { AgentTeamShare } from '@reflexion-os-studio/contracts'
import { importAgentTeam } from '../../../../api/agents'
import { RoleShareDialog } from './RoleShareDialog'

export function RoleTeamImport({
  archive,
  projectId,
  onClose,
  onImported,
}: {
  archive: AgentTeamShare
  projectId: string | null
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState('')
  return (
    <RoleShareDialog
      title={`导入团队：${archive.teamId}`}
      busy={busy}
      onClose={onClose}
    >
      <p>
        共 {archive.roles.length}{' '}
        个角色。请展开检查指令与权限。保存为新角色，默认停用、继承上级模型；同名团队将另建分组。
      </p>
      <p>目标位置：{projectId ? '当前所选项目' : '跨项目通用'}</p>
      <div className="role-share-members">
        {archive.roles.map((role, index) => (
          <details key={index}>
            <summary>
              {role.name} · {role.permissionCeiling ?? 'workspace-read'} ·{' '}
              {role.allowedTools.length} 个工具
            </summary>
            <p>{role.description}</p>
            <p>
              继续委派：{role.canDelegate ? '允许' : '不允许'}；工具：
              {role.allowedTools.join('、') || '无'}
            </p>
            <pre>{role.systemPrompt}</pre>
          </details>
        ))}
      </div>
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        disabled={busy || saved}
        onClick={async () => {
          setBusy(true)
          setMessage('')
          try {
            const result = await importAgentTeam(archive, projectId)
            setSaved(true)
            setMessage(
              `已导入 ${result.templates.length} 个角色，团队：${result.teamId}。角色默认停用，可在角色库编辑后启用。`,
            )
            await onImported().catch(() =>
              setMessage(
                `已保存团队 ${result.teamId}，列表刷新失败，请重新打开角色库。`,
              ),
            )
          } catch {
            setMessage('团队导入失败，请检查配置与目标项目；未保存任何角色。')
          } finally {
            setBusy(false)
          }
        }}
      >
        {saved
          ? '已导入'
          : busy
            ? '正在导入…'
            : `导入全部 ${archive.roles.length} 个角色`}
      </button>
    </RoleShareDialog>
  )
}
