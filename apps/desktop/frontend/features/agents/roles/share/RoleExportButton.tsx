import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { exportAgentTemplate } from '../../../../api/agents'

export function RoleExportButton({
  templateId,
  busy,
}: {
  templateId: string
  busy: boolean
}) {
  const [includeSkills, setIncludeSkills] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  return (
    <>
      <label className="agent-checkbox">
        <input
          type="checkbox"
          checked={includeSkills}
          disabled={busy || exporting}
          onChange={(event) => setIncludeSkills(event.target.checked)}
        />
        包含完整技能包（ZIP）
      </label>
      <button
        type="button"
        disabled={busy || exporting}
        onClick={async () => {
          setExporting(true)
          setMessage('')
          setFailed(false)
          try {
            const directory = await open({
              directory: true,
              multiple: false,
              title: '选择角色导出目录',
            })
            if (typeof directory !== 'string') return
            const result = await exportAgentTemplate(
              templateId,
              directory,
              includeSkills,
            )
            setMessage(`已导出：${result.path}`)
          } catch (error) {
            setFailed(true)
            setMessage(
              error instanceof Error
                ? error.message
                : '导出失败，请确认目录可写，且角色配置不包含机密。',
            )
          } finally {
            setExporting(false)
          }
        }}
      >
        {includeSkills ? '导出完整角色包' : '导出配置'}
      </button>
      {message && <small role={failed ? 'alert' : 'status'}>{message}</small>}
    </>
  )
}
