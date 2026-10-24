import type { ApprovalDisplay } from './approval-presenter'
import { CopyIcon } from '../../../ui/icons'

/**
 * 审批主体区：操作主体、关键执行范围、规则说明及低频详情。
 * 详情由卡片底栏控制；长命令限高滚动并可复制，不横向撑破卡片。
 */
export function ApprovalDetails({
  display,
  descriptionId,
  expanded = false,
  detailsId,
}: {
  display: ApprovalDisplay
  descriptionId: string
  expanded?: boolean
  detailsId?: string
}): React.JSX.Element {
  const review = display.context?.review ? (
    <section
      className="approval-config-review"
      aria-label={
        display.reviewAlwaysVisible ? display.reviewTitle : '待保存的配置'
      }
    >
      <strong>{display.reviewTitle}</strong>
      <pre tabIndex={0}>{display.context.review}</pre>
    </section>
  ) : null
  return (
    <div
      className={`approval-body${display.context?.review ? ' has-review' : ''}`}
    >
      {display.subject !== null && (
        <div
          className={`approval-subject kind-${display.subject.kind}`}
          id={descriptionId}
        >
          {display.subject.kind === 'command' ? (
            <>
              <code className="approval-command">{display.subject.value}</code>
              <button
                type="button"
                className="approval-copy"
                aria-label="复制命令"
                title="复制命令"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    display.subject?.value ?? '',
                  )
                }
              >
                <CopyIcon />
              </button>
            </>
          ) : (
            <code className="approval-path">{display.subject.value}</code>
          )}
        </div>
      )}
      {display.context?.sandbox === 'unsandboxed' && (
        <div className="approval-rule-note">
          <p>
            仅本次命令解除文件读写、敏感路径与网络的沙箱限制，以当前用户身份执行，不获得管理员权限。
          </p>
          {display.context.justification && (
            <p>理由：{display.context.justification}</p>
          )}
        </div>
      )}
      {display.writeRoots.length > 0 && (
        <div className="approval-write-roots" aria-label="本次额外可写范围">
          <p>本次额外可写范围（目录包含子目录）</p>
          <ul>
            {display.writeRoots.map((root) => (
              <li key={root}>
                <code>{root}</code>
              </li>
            ))}
          </ul>
          {display.context?.justification && (
            <p>{display.context.justification}</p>
          )}
        </div>
      )}
      {display.chips.length > 0 && (
        <div className="approval-chips" aria-label="执行范围">
          {display.chips.map((chip) => (
            <span key={chip} className={`approval-chip chip-${chipTone(chip)}`}>
              {chip}
            </span>
          ))}
        </div>
      )}
      {display.ruleNote !== null && (
        <p className="approval-rule-note">{display.ruleNote}</p>
      )}
      {display.reviewAlwaysVisible && review}
      <div
        id={detailsId}
        className="approval-expanded-details"
        hidden={!expanded}
      >
        {expanded && (
          <>
            {!display.reviewAlwaysVisible && review}
            <dl className="approval-detail-list">
              {display.details.map((item) => (
                <div key={item.label} className="approval-detail-item">
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  )
}

function chipTone(chip: string): 'neutral' | 'elevated' | 'warning' {
  if (
    chip.startsWith('提权') ||
    chip.startsWith('Danger') ||
    chip === '将联网'
  ) {
    return 'elevated'
  }
  if (chip === '将访问工作区外') return 'elevated'
  if (chip === '沙箱只读') return 'warning'
  return 'neutral'
}
