import { useCallback, useState } from 'react'
import { getDeveloperRun } from '../../../api/developer'
import { useDeveloperQuery } from '../data'
import { dateTime, duration, number, statuses } from '../format'
import { QueryFeedback } from '../QueryFeedback'
import { RunList } from './RunList'
import { ModelCalls } from './ModelCalls'
import { ToolList } from '../tools/ToolList'
import { UsageCards } from '../overview/UsageOverview'

const EMPTY_FILTER = {}
export function RunDetail(props: {
  id: string
  revision: number
  enabled?: boolean
  onRun: (id: string) => void
  onTool: (id: string) => void
  onBack: () => void
  onConversation: (sessionId: string, projectId: string | null) => void
}) {
  const [section, setSection] = useState('models')
  const load = useCallback(() => getDeveloperRun(props.id), [props.id])
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  const entry = query.data?.entry
  const run = entry?.run
  const metrics = run?.performance
  return (
    <section className="developer-detail">
      <button type="button" className="ghost" onClick={props.onBack}>
        ← 返回列表
      </button>
      <h2>运行详情</h2>
      <QueryFeedback {...query} />
      {!query.loading && !query.error && !entry && <p>记录不存在或已删除。</p>}
      {entry && run && query.data && (
        <>
          <div className="developer-heading">
            <h3>{entry.sessionTitle}</h3>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                props.onConversation(run.sessionId, entry.projectId)
              }
            >
              返回所属对话
            </button>
          </div>
          <dl className="developer-facts">
            <div>
              <dt>Run ID</dt>
              <dd>{run.id}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd className={`developer-status ${run.status}`}>
                {statuses[run.status]}
              </dd>
            </div>
            <div>
              <dt>Provider / 模型</dt>
              <dd>
                {entry.providerName ?? run.providerId ?? '未知'} /{' '}
                {run.model ?? '未知'}
              </dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{dateTime(run.startedAt)}</dd>
            </div>
            <div>
              <dt>本 Run 输入 / 输出</dt>
              <dd>
                {number(run.usage?.promptTokens)} /{' '}
                {number(run.usage?.completionTokens)}
              </dd>
            </div>
            <div>
              <dt>本 Run 缓存命中</dt>
              <dd>{number(run.usage?.cachedPromptTokens)}</dd>
            </div>
            <div>
              <dt>工具 / 失败</dt>
              <dd>
                {entry.toolCalls} / {entry.toolFailures}
              </dd>
            </div>
            <div>
              <dt>错误码</dt>
              <dd>{run.errorCode ?? '—'}</dd>
            </div>
          </dl>
          {run.parentRunId && (
            <button
              type="button"
              className="developer-link"
              onClick={() => props.onRun(run.parentRunId!)}
            >
              查看父 Run：{run.parentRunId}
            </button>
          )}
          <details>
            <summary>含子任务用量 · 共 {query.data.treeRuns} 个 Run</summary>
            <UsageCards usage={query.data.treeUsage} />
            <p className="hint">
              各 Run 累计值相加，不包含无法归属于此任务的会话标题与后台摘要。
            </p>
          </details>
          <details>
            <summary>耗时与请求诊断</summary>
            {metrics ? (
              <>
                <dl className="developer-facts">
                  {[
                    ['总历时', duration(metrics.elapsedMs)],
                    ['模型耗时', duration(metrics.modelMs)],
                    ['审批等待（累计）', duration(metrics.approvalWaitMs)],
                    ['工具执行（累计）', duration(metrics.toolExecutionMs)],
                    ['资源等待（累计）', duration(metrics.mutationWaitMs)],
                    [
                      '请求 / 重试',
                      `${metrics.requestAttempts} / ${metrics.requestRetries}`,
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="hint">并行阶段可能重叠，各项耗时不能直接相加。</p>
              </>
            ) : (
              <p className="hint">该 Run 未记录分阶段耗时。</p>
            )}
          </details>
          <nav className="developer-tabs" aria-label="运行详情分类">
            {[
              ['models', '模型轮次'],
              ['tools', '工具调用'],
              ['children', `子 Run（${entry.childRuns}）`],
            ].map(([key, label]) => (
              <button
                type="button"
                className={section === key ? 'active' : 'ghost'}
                key={key}
                aria-current={section === key ? 'page' : undefined}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {section === 'models' && (
            <ModelCalls
              runId={run.id}
              revision={props.revision}
              enabled={props.enabled}
            />
          )}
          {section === 'tools' && (
            <ToolList
              runId={run.id}
              revision={props.revision}
              enabled={props.enabled}
              onSelect={props.onTool}
            />
          )}
          {section === 'children' && (
            <RunList
              filter={EMPTY_FILTER}
              parentRunId={run.id}
              revision={props.revision}
              enabled={props.enabled}
              onSelect={props.onRun}
            />
          )}
        </>
      )}
    </section>
  )
}
