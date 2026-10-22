import { useCallback, useState } from 'react'
import type {
  DeveloperFilter,
  DeveloperRunListParams,
} from '@reflexion-os-studio/runtime-client'
import { listDeveloperRuns } from '../../../api/developer'
import { Select } from '../../../components/forms/Select'
import { useDeveloperQuery } from '../data'
import { dateTime, duration, number, statuses } from '../format'
import { Pagination, QueryFeedback } from '../QueryFeedback'

export function RunList(props: {
  filter: DeveloperFilter
  revision: number
  enabled?: boolean
  parentRunId?: string
  onSelect: (id: string) => void
}) {
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<DeveloperRunListParams['status']>()
  const load = useCallback(
    () =>
      listDeveloperRuns({
        ...props.filter,
        offset,
        limit: 25,
        status,
        parentRunId: props.parentRunId,
      }),
    [props.filter, offset, status, props.parentRunId],
  )
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  return (
    <>
      <div className="developer-list-controls">
        <label>
          运行状态
          <Select
            value={status ?? ''}
            onValueChange={(value) => {
              setStatus((value as typeof status) || undefined)
              setOffset(0)
            }}
          >
            <option value="">全部状态</option>
            {[
              'running',
              'awaiting_approval',
              'awaiting_user_input',
              'completed',
              'failed',
              'cancelled',
              'interrupted',
            ].map((value) => (
              <option key={value} value={value}>
                {statuses[value]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <QueryFeedback {...query} />
      {query.data && (
        <>
          <div className="developer-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>对话 / Run</th>
                  <th>模型</th>
                  <th>状态</th>
                  <th>输入 / 输出</th>
                  <th>耗时</th>
                  <th>工具 / 子 Run</th>
                  <th>开始时间</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((entry) => (
                  <tr key={entry.run.id}>
                    <td>
                      <button
                        type="button"
                        className="developer-link"
                        onClick={() => props.onSelect(entry.run.id)}
                      >
                        {entry.sessionTitle}
                      </button>
                      <small className="developer-meta">
                        {entry.run.parentRunId ? '子 Agent · ' : ''}
                        {entry.run.id.slice(0, 8)} ·{' '}
                        {entry.projectName ?? '独立会话'}
                      </small>
                    </td>
                    <td>
                      {entry.run.model ?? '未知'}
                      <small className="developer-meta">
                        {entry.providerName ??
                          entry.run.providerId ??
                          '未知 Provider'}
                      </small>
                    </td>
                    <td>
                      <span className={`developer-status ${entry.run.status}`}>
                        {statuses[entry.run.status]}
                      </span>
                    </td>
                    <td>
                      {number(entry.run.usage?.promptTokens)} /{' '}
                      {number(entry.run.usage?.completionTokens)}
                    </td>
                    <td>
                      {duration(
                        entry.run.performance?.elapsedMs ??
                          (entry.run.startedAt && entry.run.completedAt
                            ? Date.parse(entry.run.completedAt) -
                              Date.parse(entry.run.startedAt)
                            : null),
                      )}
                    </td>
                    <td>
                      {entry.toolCalls} / {entry.childRuns}
                    </td>
                    <td>{dateTime(entry.run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.data.total === 0 && (
            <p className="hint">没有符合条件的运行记录。</p>
          )}
          <Pagination
            total={query.data.total}
            offset={offset}
            limit={25}
            onChange={setOffset}
          />
        </>
      )}
    </>
  )
}
