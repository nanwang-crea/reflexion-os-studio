export function QueryFeedback(props: {
  loading: boolean
  error: string | null
}) {
  if (props.error)
    return (
      <p className="developer-error" role="alert">
        加载失败：{props.error}。请点击刷新重试。
      </p>
    )
  if (props.loading)
    return (
      <p className="hint" role="status">
        正在读取记录…
      </p>
    )
  return null
}

export function Pagination(props: {
  total: number
  offset: number
  limit: number
  onChange: (offset: number) => void
}) {
  return (
    <div className="developer-pagination" aria-label="分页">
      <span>
        {props.total
          ? `${props.offset + 1}–${Math.min(props.total, props.offset + props.limit)}`
          : '0'}{' '}
        / {props.total} 条
      </span>
      <button
        type="button"
        className="ghost"
        disabled={props.offset === 0}
        onClick={() => props.onChange(Math.max(0, props.offset - props.limit))}
      >
        上一页
      </button>
      <button
        type="button"
        className="ghost"
        disabled={props.offset + props.limit >= props.total}
        onClick={() => props.onChange(props.offset + props.limit)}
      >
        下一页
      </button>
    </div>
  )
}
