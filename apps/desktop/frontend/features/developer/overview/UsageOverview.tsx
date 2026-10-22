import { useCallback } from 'react'
import type {
  DeveloperFilter,
  UsageTotals,
} from '@reflexion-os-studio/runtime-client'
import { getDeveloperOverview } from '../../../api/developer'
import { useDeveloperQuery } from '../data'
import { number } from '../format'
import { QueryFeedback } from '../QueryFeedback'
import { ModelCalls } from '../runs/ModelCalls'

export function UsageCards({ usage }: { usage: UsageTotals }) {
  const reported = usage.reportedSources > 0 || usage.sources === 0
  return (
    <>
      <div className="developer-cards">
        {[
          ['输入 tokens', reported ? number(usage.promptTokens) : '未知'],
          ['输出 tokens', reported ? number(usage.completionTokens) : '未知'],
          [
            '缓存命中 tokens',
            usage.cacheReportedSources || usage.sources === 0
              ? number(usage.cachedPromptTokens)
              : '未知',
          ],
        ].map(([label, value]) => (
          <div className="developer-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>已报告用量</small>
          </div>
        ))}
      </div>
      <p className="hint">
        {usage.reportedSources} / {usage.sources} 个 Run 或辅助调用有用量；
        {usage.unreportedCalls} 次模型调用未报告用量；{usage.legacyRuns} 个 Run
        无逐轮记录。缓存信息仅 {usage.cacheReportedSources} 个来源报告。
      </p>
    </>
  )
}

export function UsageOverview(props: {
  filter: DeveloperFilter
  revision: number
  enabled?: boolean
}) {
  const load = useCallback(
    () => getDeveloperOverview(props.filter),
    [props.filter],
  )
  const query = useDeveloperQuery(load, props.revision, props.enabled)
  const data = query.data
  const max = Math.max(
    1,
    ...(data?.days.map((day) => day.promptTokens + day.completionTokens) ?? []),
  )
  return (
    <>
      <QueryFeedback {...query} />
      {data && (
        <>
          <UsageCards usage={data.usage} />
          <div className="developer-summary">
            <span>
              {number(data.runs)} 次运行 · {number(data.failedRuns)} 次失败
            </span>
            <span>
              {number(data.tools)} 次工具调用 · {number(data.failedTools)}{' '}
              次失败
            </span>
          </div>
          <p className="hint">
            包含子 Agent、标题生成与上下文摘要；各 Run
            独立计数。统计是本地已报告值，不代表账单或当前上下文占用，缓存命中不额外加到输入总量。
          </p>
          <section>
            <h3>
              每日用量 <small>UTC 日期</small>
            </h3>
            {data.days.length === 0 ? (
              <p className="hint">该范围内暂无用量记录。</p>
            ) : (
              <div className="developer-trend" aria-label="每日 token 用量">
                {data.days.map((day) => (
                  <div className="developer-trend-row" key={day.key}>
                    <span>{day.key}</span>
                    <div className="developer-bar">
                      <i
                        style={{
                          width: `${((day.promptTokens + day.completionTokens) / max) * 100}%`,
                        }}
                      />
                    </div>
                    <span>
                      {day.reportedSources
                        ? number(day.promptTokens + day.completionTokens)
                        : '未知'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section>
            <h3>模型分布</h3>
            <div className="developer-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Provider / 模型</th>
                    <th>输入</th>
                    <th>输出</th>
                    <th>有用量 / 来源</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label ?? row.key}</td>
                      <td>
                        {row.reportedSources
                          ? number(row.promptTokens)
                          : '未知'}
                      </td>
                      <td>
                        {row.reportedSources
                          ? number(row.completionTokens)
                          : '未知'}
                      </td>
                      <td>
                        {row.reportedSources} / {row.sources}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h3>工具分布</h3>
            <div className="developer-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>调用次数</th>
                    <th>失败次数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.toolGroups.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{number(row.calls)}</td>
                      <td>{number(row.failures)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h3>模型调用明细</h3>
            <p className="hint">
              升级后开始采集，包含标题和摘要；一次模型调用可能含多次 HTTP 尝试。
            </p>
            <ModelCalls
              filter={props.filter}
              revision={props.revision}
              enabled={props.enabled}
            />
          </section>
        </>
      )}
    </>
  )
}
