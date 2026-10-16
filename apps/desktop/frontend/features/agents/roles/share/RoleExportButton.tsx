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
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  return (
    <>
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
            const result = await exportAgentTemplate(templateId, directory)
            setMessage(`已导出：${result.path}`)
          } catch {
            setFailed(true)
            setMessage('导出失败，请确认目录可写，且角色配置不包含机密。')
          } finally {
            setExporting(false)
          }
        }}
      >
        导出
      </button>
      {message && <small role={failed ? 'alert' : 'status'}>{message}</small>}
    </>
  )
}
