import { useCallback, useState } from 'react'
import { getDeveloperTool } from '../../../api/developer'
import { CopyButton } from '../../../components/CopyButton'
import { useDeveloperQuery } from '../data'
import { dateTime, duration, statuses } from '../format'
import { QueryFeedback } from '../QueryFeedback'

export function ToolDetail(props: {
  id: string
  revision: number
  onRun: (runId: string) => void
  onBack: () => void
}) {
  const load = useCallback(() => getDeveloperTool(props.id), [props.id])
  const query = useDeveloperQuery(load, props.revision)
  const call = query.data
  return (
    <section className="developer-detail">
      <button type="button" className="ghost" onClick={props.onBack}>
        ← 返回
      </button>
      <h2>工具调用详情</h2>
      <QueryFeedback {...query} />
      {!query.loading && !query.error && !call && <p>记录不存在或已删除。</p>}
      {call && (
        <>
          <h3>
            {call.toolName}{' '}
            <span className={`developer-status ${call.status}`}>
              {statuses[call.status]}
            </span>
          </h3>
          <dl className="developer-facts">
            <div>
              <dt>调用 ID</dt>
              <dd>{call.id}</dd>
            </div>
            <div>
              <dt>所属 Run</dt>
              <dd>
                <button
                  type="button"
                  className="developer-link"
                  onClick={() => props.onRun(call.runId)}
                >
                  {call.runId}
                </button>
              </dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{dateTime(call.createdAt)}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{dateTime(call.completedAt)}</dd>
            </div>
            <div>
              <dt>审批等待</dt>
              <dd>{duration(call.timing?.approvalWaitMs)}</dd>
            </div>
            <div>
              <dt>资源等待</dt>
              <dd>{duration(call.timing?.mutationWaitMs)}</dd>
            </div>
            <div>
              <dt>实际执行</dt>
              <dd>{duration(call.timing?.executionMs)}</dd>
            </div>
            <div>
              <dt>错误码</dt>
              <dd>{call.errorCode ?? '—'}</dd>
            </div>
          </dl>
          <TextDetail
            label="调用参数"
            text={JSON.stringify(call.args, null, 2)}
          />
          <TextDetail
            label="工具结果"
            text={call.output?.content ?? '暂无结果'}
          />
          {call.output && (
            <TextDetail
              label="结构化结果（ToolOutput）"
              text={JSON.stringify(call.output, null, 2)}
            />
          )}
        </>
      )}
    </section>
  )
}

function TextDetail(props: { label: string; text: string }) {
  const [full, setFull] = useState(false)
  return (
    <details className="developer-output">
      <summary>{props.label}</summary>
      <CopyButton text={props.text} />
      <pre>{full ? props.text : props.text.slice(0, 8000)}</pre>
      {!full && props.text.length > 8000 && (
        <button type="button" className="ghost" onClick={() => setFull(true)}>
          显示完整内容（{props.text.length.toLocaleString()} 字符）
        </button>
      )}
    </details>
  )
}
