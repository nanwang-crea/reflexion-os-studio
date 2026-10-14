import { AttemptList } from './AttemptList'
import { NodeHistory } from './NodeHistory'
import { WorkflowValuesView } from './WorkflowValuesView'
import { useState } from 'react'
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '@reflexion-os-studio/contracts'
import type { ComponentProps } from 'react'
import * as api from '../../../api/workflow'
import { getSessionData, type SessionData } from '../../../api/sessions'
import { ApprovalQueue } from '../../chat/approvals/ApprovalQueue'

export function RunPanel({
  detail,
  runs,
  onSelect,
  onUpdate,
  action,
  approvals,
  onChoose,
  onResource,
}: {
  detail: WorkflowRunDetail | null
  runs: WorkflowRunSummary[]
  onSelect: (id: string) => void
  onUpdate: (detail: WorkflowRunDetail) => void
  action: (work: () => Promise<void>) => Promise<void>
  approvals: ComponentProps<typeof ApprovalQueue>['approvals']
  onChoose: ComponentProps<typeof ApprovalQueue>['onChoose']
  onResource?: ComponentProps<typeof WorkflowValuesView>['onResource']
}): React.JSX.Element {
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [history, setHistory] = useState<SessionData | null>(null)
  return (
    <section className="workflow-run-panel">
      <h3>运行记录</h3>
      <div className="workflow-run-list">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => {
              setAcknowledged([])
              setHistory(null)
              onSelect(run.id)
            }}
          >
            {run.name} · {run.status} ·{' '}
            {new Date(run.createdAt).toLocaleString()}
          </button>
        ))}
      </div>
      {detail && (
        <>
          <p>
            {detail.run.status} · 尝试 {detail.run.attemptsUsed} · tokens{' '}
            {detail.run.tokensUsed}
            {detail.run.tokensEstimated ? '（含估算）' : ''} · 工具{' '}
            {detail.run.toolsUsed}
          </p>
          {detail.run.errorCode && <p role="alert">{detail.run.errorCode}</p>}
          {['running', 'waiting_user', 'cancelling', 'interrupted'].includes(
            detail.run.status,
          ) && (
            <button
              type="button"
              onClick={() =>
                void action(async () =>
                  onUpdate(
                    (
                      await api.cancelWorkflow({
                        projectId: detail.run.projectId,
                        runId: detail.run.id,
                      })
                    ).detail,
                  ),
                )
              }
            >
              停止运行
            </button>
          )}
          {['failed', 'interrupted'].includes(detail.run.status) && (
            <div>
              <p>
                继续前请核查有可能已产生的文件、Shell
                或外部变更。恢复不会撤销这些操作。
              </p>
              {detail.attempts
                .filter(
                  (attempt) =>
                    ['failed', 'interrupted', 'cancelled'].includes(
                      attempt.status,
                    ) && attempt.effectStatus !== 'none',
                )
                .map((attempt) => (
                  <label key={attempt.id}>
                    <input
                      type="checkbox"
                      checked={acknowledged.includes(attempt.id)}
                      onChange={(event) =>
                        setAcknowledged((old) =>
                          event.target.checked
                            ? [...old, attempt.id]
                            : old.filter((id) => id !== attempt.id),
                        )
                      }
                    />
                    我已核查 {attempt.nodeId} 第 {attempt.attemptNo}{' '}
                    次尝试的副作用
                  </label>
                ))}
              <button
                type="button"
                onClick={() =>
                  void action(async () =>
                    onUpdate(
                      (
                        await api.resumeWorkflow({
                          projectId: detail.run.projectId,
                          runId: detail.run.id,
                          stateVersion: detail.run.stateVersion,
                          acknowledgedAttemptIds: acknowledged,
                        })
                      ).detail,
                    ),
                  )
                }
              >
                继续未完成节点
              </button>
            </div>
          )}
          <ApprovalQueue
            approvals={approvals.filter(
              (approval) =>
                approval.context?.agent?.workflowRunId === detail.run.id,
            )}
            onChoose={onChoose}
          />
          {detail.confirmations
            .filter((confirmation) => confirmation.status === 'pending')
            .map((confirmation) => {
              const attempt = detail.attempts.find(
                (attempt) => attempt.id === confirmation.attemptId,
              )!
              const node = detail.run.snapshot.definition.nodes.find(
                (node) => node.id === attempt.nodeId,
              )!
              return (
                <article
                  key={confirmation.id}
                  className="workflow-confirmation"
                >
                  <h4>{node.name}</h4>
                  <p>{node.kind === 'confirmation' ? node.instruction : ''}</p>
                  <pre>{JSON.stringify(confirmation.inputs, null, 2)}</pre>
                  <p>
                    有效期至 {new Date(confirmation.expiresAt).toLocaleString()}
                  </p>
                  {[true, false].map((approved) => (
                    <button
                      key={String(approved)}
                      type="button"
                      onClick={() =>
                        void action(async () =>
                          onUpdate(
                            (
                              await api.respondWorkflow({
                                projectId: detail.run.projectId,
                                runId: detail.run.id,
                                confirmationId: confirmation.id,
                                token: confirmation.token,
                                inputHash: confirmation.inputHash,
                                approved,
                              })
                            ).detail,
                          ),
                        )
                      }
                    >
                      {approved ? '验收通过，继续' : '拒绝验收'}
                    </button>
                  ))}
                </article>
              )
            })}
          <AttemptList
            detail={detail}
            acknowledged={acknowledged}
            action={action}
            onUpdate={onUpdate}
            onHistory={(sessionId) =>
              void action(async () =>
                setHistory(await getSessionData(sessionId)),
              )
            }
          />
          {detail.result && (
            <details open>
              <summary>最终成果</summary>
              <WorkflowValuesView
                values={detail.result}
                onResource={onResource}
              />
            </details>
          )}
          <details>
            <summary>变更文件归属</summary>
            <pre>{JSON.stringify(detail.changedFiles, null, 2)}</pre>
          </details>
          {history && (
            <NodeHistory
              history={history}
              action={action}
              onUpdate={setHistory}
            />
          )}
        </>
      )}
    </section>
  )
}
