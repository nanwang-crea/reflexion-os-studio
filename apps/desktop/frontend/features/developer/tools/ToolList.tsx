import { useCallback, useState } from 'react'
import type {
  DeveloperFilter,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import { listDeveloperTools } from '../../../api/developer'
import { Select } from '../../../components/forms/Select'
import { useDeveloperQuery } from '../data'
import { dateTime, duration, statuses } from '../format'
import { QueryFeedback, Pagination } from '../QueryFeedback'

const EMPTY_FILTER: DeveloperFilter = {}
export function ToolList(props: {
  filter?: DeveloperFilter
  revision: number
  enabled?: boolean
  runId?: string
  onSelect: (id: string) => void
}) {
  const [offset, setOffset] = useState(0)
  const [name, setName] = useState('')
  const [status, setStatus] = useState<ToolCall['status']>()
  const filter = props.filter ?? EMPTY_FILTER
  const load = useCallback(
    () =>
      listDeveloperTools({
        ...filter,
        runId: props.runId,
        toolName: name || undefined,
        status,
        offset,
        limit: 25,
      }),
    [filter, props.runId, name, status, offset],
  )
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  return (
    <>
      <div className="developer-list-controls">
        <label>
          工具名称
          <input
            aria-label="工具名称"
            placeholder="完整名称，如 file.read"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setOffset(0)
            }}
          />
        </label>
        <label>
          工具状态
          <Select
            value={status ?? ''}
            onValueChange={(value) => {
              setStatus((value as typeof status) || undefined)
              setOffset(0)
            }}
          >
            <option value="">全部状态</option>
            {[
              'pending',
              'awaiting_approval',
              'awaiting_user_input',
              'running',
              'completed',
              'failed',
              'cancelled',
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
                  <th>工具</th>
                  <th>对话 / 模型</th>
                  <th>状态</th>
                  <th>总历时（含等待）</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((call) => (
                  <tr key={call.id}>
                    <td>
                      <button
                        type="button"
                        className="developer-link"
                        onClick={() => props.onSelect(call.id)}
                      >
                        {call.toolName}
                      </button>
                      <small className="developer-meta">
                        {call.id.slice(0, 8)}
                      </small>
                    </td>
                    <td>
                      {call.sessionTitle}
                      <small className="developer-meta">
                        {call.model ?? '未知模型'}
                      </small>
                    </td>
                    <td>
                      <span className={`developer-status ${call.status}`}>
                        {statuses[call.status]}
                      </span>
                      {call.errorCode && (
                        <small className="developer-meta">
                          {call.errorCode}
                        </small>
                      )}
                    </td>
                    <td>
                      {duration(
                        call.completedAt
                          ? Date.parse(call.completedAt) -
                              Date.parse(call.createdAt)
                          : null,
                      )}
                    </td>
                    <td>{dateTime(call.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!query.data.total && (
            <p className="hint">没有符合条件的工具调用。</p>
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
