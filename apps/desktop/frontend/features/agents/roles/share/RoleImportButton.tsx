import { RoleTeamImport } from './RoleTeamImport'
import { useRef, useState } from 'react'
import {
  AgentRoleShareSchema,
  AgentTeamShareSchema,
  type AgentTeamShare,
  MAX_AGENT_TEAM_SHARE_BYTES,
  MAX_AGENT_ROLE_SHARE_BYTES,
} from '@reflexion-os-studio/contracts'
import type { RoleDraft } from '../RoleEditor'

export function RoleImportButton({
  busy,
  projectId,
  onImport,
  onTeamImported,
}: {
  onTeamImported: () => Promise<void>
  busy: boolean
  projectId: string | null
  onImport: (draft: RoleDraft) => Promise<void>
}) {
  const [team, setTeam] = useState<AgentTeamShare | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  return (
    <div>
      <button
        type="button"
        disabled={busy || reading}
        onClick={() => input.current?.click()}
      >
        导入角色
      </button>
      <input
        ref={input}
        type="file"
        accept=".reflexion-role.json,.reflexion-team.json"
        hidden
        disabled={busy || reading}
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setError('')
          setReading(true)
          try {
            const isTeam = file.name.endsWith('.reflexion-team.json')
            if (
              (!isTeam && !file.name.endsWith('.reflexion-role.json')) ||
              file.size >
                (isTeam
                  ? MAX_AGENT_TEAM_SHARE_BYTES
                  : MAX_AGENT_ROLE_SHARE_BYTES)
            )
              throw new Error('请选择角色文件（≤256KB）或团队文件（≤4MB）')
            const content: unknown = JSON.parse(await file.text())
            if (isTeam) {
              const result = AgentTeamShareSchema.safeParse(content)
              if (!result.success)
                throw new Error('团队文件格式或版本不支持，或配置字段无效')
              setTeam(result.data)
              return
            }
            const parsed = AgentRoleShareSchema.safeParse(content)
            if (!parsed.success)
              throw new Error('角色文件格式或版本不支持，或配置字段无效')
            await onImport({
              ...parsed.data.role,
              projectId,
              modelBinding: { mode: 'inherit' },
              enabled: false,
            })
          } catch (error) {
            setError(
              error instanceof SyntaxError
                ? '角色文件不是有效的 JSON'
                : error instanceof Error
                  ? error.message
                  : '导入失败',
            )
          } finally {
            setReading(false)
          }
        }}
      />
      {team && (
        <RoleTeamImport
          archive={team}
          projectId={projectId}
          onClose={() => setTeam(null)}
          onImported={onTeamImported}
        />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  )
}
