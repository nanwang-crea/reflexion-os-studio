import type { ApprovalChoice } from '@reflexion-os-studio/runtime-client'
import type { ApprovalDisplay } from './approval-presenter'

/**
 * 审批动作区：只渲染 Runtime 下发的 choices（label/description 原样展示），
 * 提交只回传 choiceId。会话级 choice 直接平铺为按钮（一次点击即完成，
 * 不再套下拉菜单）；其语义仍是"本会话内免问"，不是跨会话永久授权。
 */
export function ApprovalActions({
  display,
  busyLabel,
  onChoose,
}: {
  display: ApprovalDisplay
  /** 非空表示已提交在途：按钮禁用防重复点击。 */
  busyLabel: string | null
  onChoose: (choiceId: string) => void
}): React.JSX.Element {
  const sessionChoices = display.choices.filter(
    (choice) => choice.presentation === 'session-menu',
  )
  const deny = display.choices.find((choice) => choice.decision === 'denied')
  const primaries = display.choices.filter(
    (choice) => choice.presentation === 'primary',
  )
  const busy = busyLabel !== null

  return (
    <div className="approval-actions">
      {deny && (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => onChoose(deny.id)}
        >
          {deny.label}
        </button>
      )}
      {sessionChoices.map((choice) => (
        <SessionChoiceButton
          key={choice.id}
          choice={choice}
          disabled={busy}
          onChoose={onChoose}
        />
      ))}
      {primaries.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          className={
            primaries.length > 1 && index < primaries.length - 1
              ? 'ghost'
              : 'primary'
          }
          title={choice.description}
          disabled={busy}
          onClick={() => onChoose(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}

function SessionChoiceButton({
  choice,
  disabled,
  onChoose,
}: {
  choice: ApprovalChoice
  disabled: boolean
  onChoose: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="ghost approval-session-choice"
      title={choice.description}
      disabled={disabled}
      onClick={() => onChoose(choice.id)}
    >
      {choice.label}
    </button>
  )
}
