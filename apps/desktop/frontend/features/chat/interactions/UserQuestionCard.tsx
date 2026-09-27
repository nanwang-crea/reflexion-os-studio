import { useMemo, useState } from 'react'
import type { UserQuestionAnswer } from '@reflexion-os-studio/runtime-client'
import type { PendingInteraction } from '../../../hooks/interactions/usePendingInteractions'

export function UserQuestionCard(props: {
  interaction: PendingInteraction
  onSubmit: (
    interactionId: string,
    answers: UserQuestionAnswer[],
  ) => Promise<boolean>
}): React.JSX.Element {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const answers = useMemo(
    () =>
      props.interaction.questions.flatMap((question) => {
        const selectedOptionIds = selected[question.id] ?? []
        const customText = custom[question.id]?.trim()
        if (selectedOptionIds.length === 0 && !customText) return []
        return [
          {
            questionId: question.id,
            selectedOptionIds,
            ...(customText ? { customText } : {}),
          },
        ]
      }),
    [custom, props.interaction.questions, selected],
  )

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    const accepted = await props
      .onSubmit(props.interaction.interactionId, answers)
      .catch(() => false)
    if (!accepted) setSubmitting(false)
  }

  return (
    <section
      className="user-question-card"
      aria-label={
        props.interaction.kind === 'plan_approval' ? '计划审批' : 'Agent 提问'
      }
    >
      {props.interaction.agent !== undefined &&
        props.interaction.agent.depth > 0 && (
          <div className="agent-source interaction-agent-source">
            {props.interaction.agent.displayName} · 子 Agent · 第{' '}
            {props.interaction.agent.depth} 层
          </div>
        )}
      {props.interaction.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>
            <span>{question.header}</span>
            {question.question}
          </legend>
          <div className="user-question-options">
            {question.options.map((option) => {
              const values = selected[question.id] ?? []
              const checked = values.includes(option.id)
              return (
                <label key={option.id} className={checked ? 'selected' : ''}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={question.id}
                    checked={checked}
                    onChange={() =>
                      setSelected((current) => ({
                        ...current,
                        [question.id]: question.multiSelect
                          ? checked
                            ? values.filter((id) => id !== option.id)
                            : [...values, option.id]
                          : [option.id],
                      }))
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              )
            })}
          </div>
          <textarea
            rows={2}
            maxLength={1000}
            placeholder="其他答案（可选）"
            value={custom[question.id] ?? ''}
            onChange={(event) =>
              setCustom((current) => ({
                ...current,
                [question.id]: event.target.value,
              }))
            }
          />
        </fieldset>
      ))}
      <div className="user-question-actions">
        <button
          type="button"
          className="ghost"
          disabled={submitting}
          onClick={() => void submit()}
        >
          跳过
        </button>
        <button
          type="button"
          className="primary"
          disabled={submitting || answers.length === 0}
          onClick={() => void submit()}
        >
          提交回答
        </button>
      </div>
    </section>
  )
}
