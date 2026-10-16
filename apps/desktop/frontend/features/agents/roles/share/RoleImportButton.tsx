import { RolePackageImport } from './RolePackageImport'
import { previewAgentRolePackage } from '../../../../api/agents'
import type { AgentRolePackagePreview } from '@reflexion-os-studio/contracts'
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
  onFeedback,
}: {
  onTeamImported: (projectId: string | null) => Promise<void>
  onFeedback: (message: string, failed?: boolean) => void
  busy: boolean
  projectId: string | null
  onImport: (draft: RoleDraft) => Promise<boolean>
}) {
  const [bundle, setBundle] = useState<{
    data: string
    preview: AgentRolePackagePreview
    projectId: string | null
  } | null>(null)
  const [team, setTeam] = useState<AgentTeamShare | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  return (
    <div>
      <button
        type="button"
        disabled={busy || reading}
        onClick={() => input.current?.click()}
      >
        {reading ? '正在读取…' : '导入角色'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".reflexion-role.json,.reflexion-team.json,.json,.txt,.zip"
        hidden
        disabled={busy || reading}
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          onFeedback(`正在读取并校验“${file.name}”…`)
          setReading(true)
          try {
            if (file.name.toLowerCase().endsWith('.zip')) {
              if (file.size > 32 * 1024 * 1024)
                throw new Error('角色 ZIP 不得超过 32MB')
              const bytes = new Uint8Array(await file.arrayBuffer())
              let binary = ''
              for (let offset = 0; offset < bytes.length; offset += 32768)
                binary += String.fromCharCode(
                  ...bytes.subarray(offset, offset + 32768),
                )
              const data = btoa(binary)
              const preview = await previewAgentRolePackage(data, projectId)
              setBundle({ data, preview, projectId })
              onFeedback(
                `“${file.name}”校验通过，请在预览中确认导入；尚未保存。`,
              )
              return
            }
            if (file.size > MAX_AGENT_TEAM_SHARE_BYTES)
              throw new Error(
                'JSON 文件超过 4MB 上限；角色配置限 256KB，团队配置限 4MB',
              )
            const content: unknown = JSON.parse(
              (await file.text()).replace(/^\uFEFF/, ''),
            )
            const format =
              typeof content === 'object' &&
              content !== null &&
              'format' in content
                ? content.format
                : null
            if (format === 'reflexion-team') {
              const result = AgentTeamShareSchema.safeParse(content)
              if (!result.success)
                throw new Error('团队文件格式或版本不支持，或配置字段无效')
              setTeam(result.data)
              onFeedback(
                `团队文件校验通过，包含 ${result.data.roles.length} 个角色，请在预览中确认导入；尚未保存。`,
              )
              return
            }
            if (format !== 'reflexion-role')
              throw new Error(
                '文件内容缺少有效的 format：应为 reflexion-role 或 reflexion-team；修改文件名不能转换格式',
              )
            if (file.size > MAX_AGENT_ROLE_SHARE_BYTES)
              throw new Error('角色配置超过 256KB 上限')
            const parsed = AgentRoleShareSchema.safeParse(content)
            if (!parsed.success)
              throw new Error('角色文件格式或版本不支持，或配置字段无效')
            const opened = await onImport({
              ...parsed.data.role,
              projectId,
              modelBinding: { mode: 'inherit' },
              enabled: false,
            })
            onFeedback(
              opened
                ? `角色“${parsed.data.role.name}”已读取到编辑器，尚未保存。请检查配置后点击“保存角色”。`
                : '未切换到导入角色，未保存任何角色。',
            )
          } catch (error) {
            onFeedback(
              error instanceof SyntaxError
                ? '角色文件不是有效的 JSON'
                : error instanceof Error
                  ? error.message
                  : '导入失败',
              true,
            )
          } finally {
            setReading(false)
          }
        }}
      />
      {bundle && (
        <RolePackageImport
          {...bundle}
          onClose={() => setBundle(null)}
          onImported={onTeamImported}
          onFeedback={onFeedback}
        />
      )}
      {team && (
        <RoleTeamImport
          archive={team}
          projectId={projectId}
          onClose={() => setTeam(null)}
          onImported={onTeamImported}
          onFeedback={onFeedback}
        />
      )}
    </div>
  )
}
