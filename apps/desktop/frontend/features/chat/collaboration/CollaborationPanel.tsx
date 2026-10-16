import { collaborationStatus } from './presentation'
import { useMemo, useState } from 'react'
import type { ComponentProps } from 'react'
import type { ChatView } from '../ChatView'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { Select } from '../../../components/forms/Select'
import { cancelDelegation } from '../../../api/agents'
import { ChildAgentTrace } from '../run/ChildAgentTrace'
import { CollaborationGraph } from './CollaborationGraph'
import { useCollaborationTree } from './useCollaborationTree'
import { SaveCollaborationSkill } from './SaveCollaborationSkill'
import './collaboration.css'
import { TaskResults } from './results/TaskResults'

export function CollaborationPanel({
  chat,
  onCollapse,
}: {
  chat: ComponentProps<typeof ChatView>
  onCollapse: () => void
}): React.JSX.Element {
  const runs = useMemo(
    () =>
      (chat.sessionData?.runs ?? []).filter(
        (run) => run.parentRunId === null && run.supersededByRunId === null,
      ),
    [chat.sessionData],
  )
  const [chosen, setChosen] = useState<string | null>(null)
  const run = runs.find((run) => run.id === chosen) ?? runs.at(-1) ?? null
  const { items, error, refresh } = useCollaborationTree(run?.id ?? null)
  const [selected, setSelected] = useState<Delegation | null>(null)
  const [savingSkill, setSavingSkill] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const plans = chat.sessionData?.plans ?? []
  const plan =
    plans.find((plan) => plan.id === run?.planId) ??
    [...plans]
      .reverse()
      .find((plan) =>
        chat.sessionData?.messages.some(
          (message) =>
            message.id === plan.messageId && message.runId === run?.id,
        ),
      ) ??
    null
  const pending =
    chat.pendingApprovals.filter(
      (approval) =>
        approval.runId === run?.id ||
        approval.context?.agent?.rootRunId === run?.id,
    ).length +
    chat.pendingInteractions.filter(
      (interaction) =>
        interaction.runId === run?.id ||
        interaction.agent?.rootRunId === run?.id,
    ).length
  const selectedItem =
    selected && (selected.rootRunId ?? selected.parentRunId) === run?.id
      ? (items.find((item) => item.id === selected.id) ?? selected)
      : null
  return (
    <section className="collaboration-panel" aria-label="Agent 协作">
      <header className="collaboration-heading">
        <div>
          <strong>成果与协作</strong>
          <small>查看文件、追溯修改，并向主 Agent 反馈</small>
        </div>
        <button type="button" onClick={onCollapse}>
          收起
        </button>
      </header>
      {runs.length > 0 && (
        <div className="collaboration-toolbar">
          <label>
            任务
            <Select
              value={run?.id ?? ''}
              onValueChange={(id) => {
                setChosen(id)
                setSelected(null)
              }}
            >
              {runs.map((run, index) => (
                <option key={run.id} value={run.id}>
                  任务 {index + 1} · {collaborationStatus(run.status)} ·{' '}
                  {run.model}
                </option>
              ))}
            </Select>
          </label>
          {run?.status === 'completed' && (
            <button type="button" onClick={() => setSavingSkill(true)}>
              保存为协作 Skill
            </button>
          )}
        </div>
      )}
      {pending > 0 && (
        <p className="collaboration-attention" role="status">
          {pending} 项等待确认，请在左侧对话中处理。
        </p>
      )}
      {(error || notice) && <p role="alert">{error ?? notice}</p>}
      {run ? (
        <div className="collaboration-work">
          <TaskResults
            key={run.id}
            chat={chat}
            runId={run.id}
            items={items}
            onSelect={setSelected}
          />
          <details
            className="collaboration-details"
            onToggle={(event) => setShowDetails(event.currentTarget.open)}
          >
            <summary>执行详情</summary>
            <div className="collaboration-legend">
              <span>虚线：计划顺序</span>
              <span>实线：实际 Agent 委派</span>
            </div>
            {showDetails && (
              <CollaborationGraph
                run={run}
                plan={plan}
                items={items}
                onSelect={setSelected}
              />
            )}
            <div className="collaboration-agents" aria-label="协作 Agent 列表">
              {items.map((item) => (
                <article key={item.id}>
                  <button type="button" onClick={() => setSelected(item)}>
                    {item.agentInstance?.name ?? item.agentId} ·{' '}
                    {collaborationStatus(item.status)}
                  </button>
                  <small>
                    {item.agentInstance?.workspaceRoot ?? '当前会话工作空间'} ·{' '}
                    {item.execution?.model}
                  </small>
                  <small>
                    {item.structuredResult?.changedFiles.length ?? 0} 个变更文件
                  </small>
                  {['pending', 'running'].includes(item.status) && (
                    <button
                      type="button"
                      onClick={() =>
                        void cancelDelegation(item.id)
                          .then(refresh)
                          .catch((error) => setNotice(String(error)))
                      }
                    >
                      停止此 Agent
                    </button>
                  )}
                </article>
              ))}
              {!items.length && (
                <p>主 Agent 正在独立处理。需要分工时，协作节点会显示在这里。</p>
              )}
            </div>
          </details>
        </div>
      ) : (
        <div className="collaboration-empty">
          <h3>从对话开始</h3>
          <p>
            直接描述你想完成的目标。Agent 会按需要制定计划、选择角色并执行。
          </p>
        </div>
      )}
      {selectedItem && (
        <ChildAgentTrace
          key={selectedItem.id}
          delegation={selectedItem}
          onClose={() => setSelected(null)}
        />
      )}
      {savingSkill && (
        <SaveCollaborationSkill
          items={items}
          projectId={chat.sessionData?.session?.projectId ?? null}
          onClose={() => setSavingSkill(false)}
        />
      )}
    </section>
  )
}
