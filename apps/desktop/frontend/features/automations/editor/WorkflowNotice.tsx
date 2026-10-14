import type { WorkflowValidationResult } from '@reflexion-os-studio/contracts'

export function WorkflowNotice({
  error,
  validation,
}: {
  error: string | null
  validation: WorkflowValidationResult | null
}): React.JSX.Element | null {
  if (!error && !validation) return null
  return (
    <div className="workflow-notice">
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      {validation && (
        <details open={!validation.valid}>
          <summary>
            {validation.valid
              ? '✓ 运行前校验通过'
              : `校验发现 ${validation.issues.length} 个问题`}
          </summary>
          {validation.issues.map((issue, index) => (
            <p key={index}>
              {issue.path}：{issue.message}
            </p>
          ))}
        </details>
      )}
    </div>
  )
}
