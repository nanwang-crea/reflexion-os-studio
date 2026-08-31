import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillManifest } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon, SendIcon, ShieldIcon, StopIcon } from '../ui/icons'

export interface ComposerModelOption {
  /** `${providerId}::${model}` */
  key: string
  label: string
  group: string
}

interface ComposerProps {
  placeholder: string
  disabled?: boolean
  /** 有 Run 进行中时为 true：显示停止按钮并阻止提交。 */
  busy?: boolean
  autoFocus?: boolean
  /** 权限 Profile（workspace / read-only），随工具能力上线生效。 */
  permissionValue?: string
  onPermissionChange?: (value: string) => void
  modelOptions?: ComposerModelOption[]
  selectedModelKey?: string | null
  onModelChange?: (key: string) => void
  /** 可用技能清单：输入 / 时弹出斜杠补全；缺省不启用。 */
  skills?: SkillManifest[]
  /**
   * 受控的预填：值变化时把 Composer 内容设为 `/${skillId} ` 并聚焦。
   * 主要给 SkillsView 的"在对话中使用"按钮触发，回到 chat 时把斜杠带上。
   */
  prefill?: { skillId: string; nonce: number } | null
  onSend: (content: string) => Promise<void> | void
  onStop?: () => Promise<void> | void
}

/** 输入停留在技能名上（/xxx 且未加空格/参数）时才弹浮层。 */
const SLASH_QUERY_RE = /^\/([a-z0-9-]*)$/

export function Composer(props: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = props.busy ?? false
  const showModelSelect =
    props.modelOptions !== undefined &&
    props.modelOptions.length > 0 &&
    props.onModelChange !== undefined

  const slashMatches = useMemo(() => {
    if (props.skills === undefined) return []
    const query = SLASH_QUERY_RE.exec(draft)?.[1]
    if (query === undefined) return []
    return props.skills.filter((skill) => skill.id.startsWith(query))
  }, [draft, props.skills])
  const slashOpen = slashMatches.length > 0 && !slashDismissed
  const activeIndex = Math.min(slashIndex, slashMatches.length - 1)

  // 外部触发（SkillsView "在对话中使用"）：以 nonce 触发，相同 nonce 不重复预填。
  const lastPrefillNonce = useRef<number>(-1)
  useEffect(() => {
    const prefill = props.prefill
    if (prefill === undefined || prefill === null) return
    if (prefill.nonce === lastPrefillNonce.current) return
    lastPrefillNonce.current = prefill.nonce
    setDraft(`/${prefill.skillId} `)
    setSlashIndex(0)
    setSlashDismissed(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.focus()
      const length = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(length, length)
    }
  }, [props.prefill])

  const applySkill = (skillId: string): void => {
    setDraft(`/${skillId} `)
    setSlashIndex(0)
    setSlashDismissed(false)
    textareaRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    const content = draft.trim()
    // busy 时仍允许发送:消息进入会话队列,上一条回复结束后自动发出。
    if (!content || props.disabled || sending) return
    setDraft('')
    setSlashIndex(0)
    setSlashDismissed(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setSending(true)
    try {
      await props.onSend(content)
    } finally {
      setSending(false)
    }
  }

  const groups: { group: string; options: ComposerModelOption[] }[] = []
  for (const option of props.modelOptions ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.group === option.group) {
      last.options.push(option)
    } else {
      groups.push({ group: option.group, options: [option] })
    }
  }

  return (
    <div className="composer">
      {slashOpen && (
        <div className="slash-menu" role="listbox" aria-label="可用技能">
          {slashMatches.map((skill, index) => (
            <button
              key={skill.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={
                index === activeIndex ? 'slash-item active' : 'slash-item'
              }
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => applySkill(skill.id)}
            >
              <span className="slash-id">/{skill.id}</span>
              <span className="slash-name">{skill.name}</span>
              <span className="slash-desc">{skill.description}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setSlashIndex(0)
          setSlashDismissed(false)
          const element = event.target
          element.style.height = 'auto'
          element.style.height = `${Math.min(element.scrollHeight, 200)}px`
        }}
        onKeyDown={(event) => {
          if (slashOpen) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSlashIndex((activeIndex + 1) % slashMatches.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSlashIndex(
                (activeIndex - 1 + slashMatches.length) % slashMatches.length,
              )
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              applySkill(slashMatches[activeIndex].id)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setSlashDismissed(true)
            }
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        {props.permissionValue !== undefined && props.onPermissionChange && (
          <label
            className="composer-select permission"
            title="工具权限模式（随工具能力上线生效）"
          >
            <ShieldIcon />
            <select
              value={props.permissionValue}
              onChange={(event) =>
                props.onPermissionChange?.(event.target.value)
              }
            >
              <option value="workspace">工作区读写</option>
              <option value="read-only">只读</option>
            </select>
            <ChevronIcon />
          </label>
        )}
        <span className="bar-spacer" />
        {showModelSelect && (
          <label className="composer-select model" title="对话使用的模型">
            <select
              value={props.selectedModelKey ?? ''}
              onChange={(event) => props.onModelChange?.(event.target.value)}
            >
              {groups.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronIcon />
          </label>
        )}
        {props.modelOptions !== undefined &&
          props.modelOptions.length === 0 && (
            <span className="composer-no-model">未配置模型</span>
          )}
        {busy && props.onStop ? (
          <button
            className="composer-stop"
            aria-label="停止"
            title="停止当前回复"
            onClick={() => void props.onStop?.()}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="composer-send"
            aria-label="发送"
            title="发送"
            disabled={props.disabled || !draft.trim() || sending}
            onClick={() => void submit()}
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
