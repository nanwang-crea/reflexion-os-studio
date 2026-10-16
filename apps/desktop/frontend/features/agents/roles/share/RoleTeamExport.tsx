import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  AgentTeamShareSchema,
  type AgentTemplate,
  type Project,
} from '@reflexion-os-studio/contracts'
import { exportAgentTeam } from '../../../../api/agents'
import { Select } from '../../../../components/forms/Select'
import { RoleShareDialog } from './RoleShareDialog'

export function RoleTeamExport({
  templates,
  projects,
  busy,
  scope,
  domain,
}: {
  templates: AgentTemplate[]
  projects: Project[]
  busy: boolean
  scope: string
  domain: string
}) {
  const [opened, setOpened] = useState(false)
  const [key, setKey] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')
  const groups = new Map<
    string,
    { teamId: string; projectId: string | null; roles: AgentTemplate[] }
  >()
  for (const role of templates) {
    if (scope !== '*' && role.projectId !== null && role.projectId !== scope)
      continue
    for (const tag of role.domains.filter(
      (tag) =>
        tag.startsWith('team:') &&
        AgentTeamShareSchema.shape.teamId.safeParse(tag.slice(5)).success,
    )) {
      const teamId = tag.slice(5)
      const id = JSON.stringify([role.projectId, teamId])
      const group = groups.get(id) ?? {
        teamId,
        projectId: role.projectId,
        roles: [],
      }
      group.roles.push(role)
      groups.set(id, group)
    }
  }
  const group = groups.get(key)
  const chosen = group?.roles.filter((role) => selected.includes(role.id)) ?? []
  const selectTeam = (id: string) => {
    setKey(id)
    setSelected(groups.get(id)?.roles.map((role) => role.id) ?? [])
    setMessage('')
  }
  return (
    <>
      <button
        className="agent-team-export-trigger"
        type="button"
        disabled={busy || !groups.size}
        onClick={() => {
          const entry =
            [...groups].find(
              ([, group]) => `team:${group.teamId}` === domain,
            ) ?? [...groups][0]
          selectTeam(entry[0])
          setOpened(true)
        }}
      >
        导出团队
      </button>
      {opened && (
        <RoleShareDialog
          title="导出团队角色"
          busy={exporting}
          onClose={() => setOpened(false)}
        >
          <label>
            选择团队
            <Select value={key} onValueChange={selectTeam} disabled={exporting}>
              {[...groups].map(([id, team]) => (
                <option key={id} value={id}>
                  {team.teamId} ·{' '}
                  {team.projectId
                    ? (projects.find((project) => project.id === team.projectId)
                        ?.name ?? '原项目不可用')
                    : '跨项目通用'}
                  （{team.roles.length} 个角色）
                </option>
              ))}
            </Select>
          </label>
          <p>
            默认选择该团队全部角色，包含停用角色。可取消勾选后仅导出部分成员。
          </p>
          <div className="role-share-actions">
            <button
              type="button"
              disabled={exporting || !group}
              onClick={() =>
                setSelected(group?.roles.map((role) => role.id) ?? [])
              }
            >
              全选角色
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => setSelected([])}
            >
              清空选择
            </button>
            <span role="status">
              已选 {chosen.length} / {group?.roles.length ?? 0} 个角色
            </span>
          </div>
          <div className="role-share-members">
            {group?.roles.map((role) => (
              <label key={role.id} className="agent-checkbox">
                <input
                  type="checkbox"
                  disabled={exporting}
                  checked={selected.includes(role.id)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(role.id)
                        ? current.filter((id) => id !== role.id)
                        : [...current, role.id],
                    )
                  }
                />
                {role.name}
                {!role.enabled && '（已停用）'}
              </label>
            ))}
          </div>
          {message && <p role="status">{message}</p>}
          <button
            type="button"
            disabled={
              exporting || !chosen.length || chosen.length > 500 || !group
            }
            onClick={async () => {
              if (!group) return
              setExporting(true)
              setMessage('')
              try {
                const directory = await open({
                  directory: true,
                  multiple: false,
                  title: '选择团队导出目录',
                })
                if (typeof directory !== 'string') return
                const result = await exportAgentTeam({
                  teamId: group.teamId,
                  projectId: group.projectId,
                  templateIds: chosen.map((role) => role.id),
                  directory,
                })
                setMessage(`已导出 ${result.roleCount} 个角色：${result.path}`)
              } catch {
                setMessage(
                  '导出失败，请确认目录可写且角色仍属于该团队，配置无机密、未超过大小上限。',
                )
              } finally {
                setExporting(false)
              }
            }}
          >
            {exporting ? '正在导出…' : `导出所选角色（${chosen.length}）`}
          </button>
        </RoleShareDialog>
      )}
    </>
  )
}
