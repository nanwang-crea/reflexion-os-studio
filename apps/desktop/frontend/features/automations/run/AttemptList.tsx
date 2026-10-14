import type { WorkflowRunDetail } from '@reflexion-os-studio/contracts'
import * as api from '../../../api/workflow'

export function AttemptList({
  detail,
  acknowledged,
  action,
  onUpdate,
  onHistory,
}: {
  detail: WorkflowRunDetail
  acknowledged: string[]
  action: (work: () => Promise<void>) => Promise<void>
  onUpdate: (detail: WorkflowRunDetail) => void
  onHistory: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <div className="workflow-attempt-list">
      {detail.attempts.map((attempt) => (
        <details
          className="workflow-attempt"
          key={attempt.id}
          open={['failed', 'interrupted', 'running', 'waiting_user'].includes(
            attempt.status,
          )}
        >
          <summary>
            {
              detail.run.snapshot.definition.nodes.find(
                (node) => node.id === attempt.nodeId,
              )?.name
            }{' '}
            · #{attempt.attemptNo} · {attempt.status}
          </summary>
          {attempt.errorCode && <p>{attempt.errorCode}</p>}
          {attempt.sessionId && (
            <button type="button" onClick={() => onHistory(attempt.sessionId!)}>
              查看节点轨迹
            </button>
          )}
          {['failed', 'interrupted'].includes(detail.run.status) &&
            ['failed', 'interrupted', 'cancelled'].includes(attempt.status) && (
              <button
                type="button"
                onClick={() =>
                  void action(async () =>
                    onUpdate(
                      (
                        await api.retryWorkflowNode({
                          projectId: detail.run.projectId,
                          runId: detail.run.id,
                          nodeId: attempt.nodeId,
                          stateVersion: detail.run.stateVersion,
                          acknowledgedAttemptIds: acknowledged,
                        })
                      ).detail,
                    ),
                  )
                }
              >
                重试此节点
              </button>
            )}
          <details>
            <summary>输入 / 成果</summary>
            <pre>
              {JSON.stringify(
                {
                  inputHash: attempt.inputHash,
                  outputs: detail.outputs.find(
                    (output) => output.attemptId === attempt.id,
                  )?.values,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </details>
      ))}
    </div>
  )
}
