import { useCallback, useState } from 'react'
import type { DeveloperFilter } from '@reflexion-os-studio/runtime-client'
import {
  listDeveloperModels,
  listDeveloperAttempts,
} from '../../../api/developer'
import { useDeveloperQuery } from '../data'
import { dateTime, duration, number, purposes, statuses } from '../format'
import { Pagination, QueryFeedback } from '../QueryFeedback'

const EMPTY_FILTER: DeveloperFilter = {}
export function ModelCalls(props: {
  filter?: DeveloperFilter
  runId?: string
  revision: number
  enabled?: boolean
}) {
  const [offset, setOffset] = useState(0)
  const [messageId, setMessageId] = useState<string | null>(null)
  const filter = props.filter ?? EMPTY_FILTER
  const load = useCallback(
    () =>
      listDeveloperModels({ ...filter, runId: props.runId, offset, limit: 10 }),
    [filter, props.runId, offset],
  )
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  return (
    <>
      <QueryFeedback {...query} />
      {query.data && (
        <>
          <div className="developer-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>用途 / 模型</th>
                  <th>状态</th>
                  <th>输入 / 输出</th>
                  <th>缓存命中</th>
                  <th>估算输入 / 窗口</th>
                  <th>耗时</th>
                  <th>开始时间</th>
                  <th>请求</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((call) => (
                  <tr key={call.id}>
                    <td>
                      {purposes[call.purpose]}
                      <small className="developer-meta">{call.model}</small>
                    </td>
                    <td>
                      {statuses[call.status]}
                      {call.errorCode && (
                        <small className="developer-meta">
                          {call.errorCode}
                        </small>
                      )}
                    </td>
                    <td>
                      {number(call.usage?.promptTokens)} /{' '}
                      {number(call.usage?.completionTokens)}
                    </td>
                    <td>{number(call.usage?.cachedPromptTokens)}</td>
                    <td>
                      {number(call.estimatedInputTokens)} /{' '}
                      {number(call.contextWindow)}
                    </td>
                    <td>{duration(call.durationMs)}</td>
                    <td>{dateTime(call.startedAt)}</td>
                    <td>
                      {call.messageId ? (
                        <button
                          className="developer-link"
                          type="button"
                          onClick={() => setMessageId(call.messageId)}
                        >
                          查看尝试
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.data.total === 0 && (
            <p className="hint">暂无逐轮记录；历史累计用量仍保留在 Run 中。</p>
          )}
          <Pagination
            total={query.data.total}
            offset={offset}
            limit={10}
            onChange={setOffset}
          />
        </>
      )}
      {messageId && (
        <section className="developer-detail">
          <button
            type="button"
            className="ghost"
            onClick={() => setMessageId(null)}
          >
            关闭请求详情
          </button>
          <RequestAttempts
            key={messageId}
            messageId={messageId}
            revision={props.revision}
            enabled={props.enabled}
          />
        </section>
      )}
    </>
  )
}

function RequestAttempts(props: {
  messageId: string
  revision: number
  enabled?: boolean
}) {
  const [offset, setOffset] = useState(0)
  const load = useCallback(
    () => listDeveloperAttempts(props.messageId, offset),
    [props.messageId, offset],
  )
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  return (
    <>
      <h4>HTTP 请求尝试</h4>
      <QueryFeedback {...query} />
      {query.data && (
        <>
          {query.data.items.map((attempt) => (
            <dl className="developer-facts" key={attempt.id}>
              <div>
                <dt>状态 / 次数</dt>
                <dd>
                  {statuses[attempt.status]} / {attempt.attempt}
                </dd>
              </div>
              <div>
                <dt>响应状态</dt>
                <dd>{attempt.responseStatus ?? '未知'}</dd>
              </div>
              <div>
                <dt>首数据</dt>
                <dd>{duration(attempt.firstDataMs)}</dd>
              </div>
              <div>
                <dt>首文字</dt>
                <dd>{duration(attempt.firstTextMs)}</dd>
              </div>
              <div>
                <dt>总耗时</dt>
                <dd>{duration(attempt.durationMs)}</dd>
              </div>
              <div>
                <dt>Request ID</dt>
                <dd>{attempt.providerRequestId ?? '未报告'}</dd>
              </div>
              <div>
                <dt>错误</dt>
                <dd>{attempt.errorCode ?? '—'}</dd>
              </div>
            </dl>
          ))}
          <Pagination
            total={query.data.total}
            offset={offset}
            limit={10}
            onChange={setOffset}
          />
        </>
      )}
    </>
  )
}
