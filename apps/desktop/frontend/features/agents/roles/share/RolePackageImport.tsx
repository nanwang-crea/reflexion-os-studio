import { useState } from 'react'
import type { AgentRolePackagePreview } from '@reflexion-os-studio/contracts'
import { importAgentRolePackage } from '../../../../api/agents'
import { RoleShareDialog } from './RoleShareDialog'

export function RolePackageImport({
  data,
  preview,
  projectId,
  onClose,
  onImported,
}: {
  data: string
  preview: AgentRolePackagePreview
  projectId: string | null
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <RoleShareDialog title="导入完整角色包" busy={busy} onClose={onClose}>
      <h3>{preview.role.name}</h3>
      <p>{preview.role.description}</p>
      <p>
        导入至{projectId ? '当前选定项目' : '全局'}
        。新角色默认停用，模型继承上级。技能不会扩大执行权限。
      </p>
      <p>
        权限上限：{preview.role.permissionCeiling}；允许工具：
        {preview.role.allowedTools.join('、') || '无'}；
        {preview.role.canDelegate ? '可委派子任务' : '不可委派子任务'}。
      </p>
      <details>
        <summary>检查角色指令</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>
          {preview.role.systemPrompt}
        </pre>
      </details>
      <ul>
        {preview.skills.map((skill) => (
          <li key={skill.id}>
            {skill.id} v{skill.version} ·{' '}
            {skill.action === 'reuse'
              ? '复用已安装的相同内容'
              : '安装完整技能包'}{' '}
            ·{' '}
            {preview.role.skills?.find((item) => item.skillId === skill.id)
              ?.mode === 'startup'
              ? '启动加载'
              : '按需优先'}
          </li>
        ))}
      </ul>
      <p>技能包含的脚本不会在导入时执行。冲突包不会覆盖已有技能。</p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            await importAgentRolePackage(data, projectId, preview.digest)
            await onImported()
            onClose()
          } catch (error) {
            setError(error instanceof Error ? error.message : '导入失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '正在导入…' : '确认导入'}
      </button>
    </RoleShareDialog>
  )
}
