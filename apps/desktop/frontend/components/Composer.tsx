import { useComposerImages } from './composer/useComposerImages'
import { ImageAttachments } from './composer/ImageAttachments'
import { isComposing } from '../lib/keyboard'
import { Select } from './forms/Select'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTemplate,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import type {
  ApprovalOverride,
  PermissionPreset,
} from '@reflexion-os-studio/runtime-client'
import {
  PERMISSION_PRESET_HINTS,
  PERMISSION_PRESET_LABELS,
} from '../hooks/permissions/usePermissionPreset'
import { ChevronIcon, SendIcon, ShieldIcon, StopIcon } from '../ui/icons'
import { ComposerRunConfig } from './ComposerRunConfig'

import {
  ModelSelector,
  type ComposerModelOption,
  type ReasoningSelection,
} from './composer/ModelSelector'
export type { ComposerModelOption } from './composer/ModelSelector'

/** 高级权限入口的会话态（ask-everything 覆盖项 + Danger 租约）。 */
export interface ComposerAdvancedState {
  approvalOverride: ApprovalOverride
  onApprovalOverrideChange: (value: ApprovalOverride) => void
  /** Runtime 有活跃 Danger 租约（横幅在场时入口显示激活态）。 */
  dangerActive: boolean
  onOpenDanger: () => void
}

interface ComposerProps {
  placeholder: string
  disabled?: boolean
  /**
   * 有 Run 进行中时为 true：输入框为空时按钮显示为停止；输入内容后
   * 按钮切回发送（消息进入会话队列），清空后回到停止。
   */
  busy?: boolean
  autoFocus?: boolean
  /** 三档日常权限预设，随发送生效。 */
  permissionValue?: PermissionPreset
  onPermissionChange?: (value: PermissionPreset) => void
  /** 高级入口（所有操作均询问 / Danger）；缺省不渲染。 */
  advanced?: ComposerAdvancedState
  modelOptions?: ComposerModelOption[]
  reasoningSelection?: ReasoningSelection
  selectedModelKey?: string | null
  onModelChange?: (key: string) => void
  /** 可用技能清单：输入 / 时弹出斜杠补全；缺省不启用。 */
  skills?: SkillManifest[]
  agentTemplates?: AgentTemplate[]
  /**
   * 受控的预填：值变化时把 Composer 内容设为 `/${skillId} ` 并聚焦。
   * 主要给 SkillsView 的"在对话中使用"按钮触发，回到 chat 时把斜杠带上。
   */
  prefill?: { skillId: string; nonce: number } | null
  onSend: (
    content: string,
    agentTemplateId?: string,
    images?: File[],
  ) => Promise<void> | void
  onStop?: () => Promise<void> | void
}

/** 输入停留在技能名上（/xxx 且未加空格/参数）时才弹浮层。 */
const SLASH_QUERY_RE = /^\/([a-z0-9-]*)$/

export function Composer(props: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const attachments = useComposerImages()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [agentTemplateId, setAgentTemplateId] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = props.busy ?? false
  // 单按钮状态机：busy 且输入框无内容 → 停止当前回复；一旦输入（或清空）
  // 按钮在停止/发送间切换，发送在 busy 下的语义是入队排队。
  const hasDraft = draft.trim().length > 0 || attachments.images.length > 0
  const showStop = busy && !hasDraft
  const showModelSelect =
    props.modelOptions !== undefined &&
    props.modelOptions.length > 0 &&
    props.onModelChange !== undefined
  const enabledAgentTemplates = useMemo(
    () => props.agentTemplates?.filter((template) => template.enabled) ?? [],
    [props.agentTemplates],
  )

  useEffect(() => {
    if (
      agentTemplateId !== '' &&
      !enabledAgentTemplates.some((template) => template.id === agentTemplateId)
    ) {
      setAgentTemplateId('')
    }
  }, [agentTemplateId, enabledAgentTemplates])

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
    const content =
      draft.trim() || (attachments.images.length ? '请分析这些图片。' : '')
    if (!content || props.disabled || sending) return
    setSending(true)
    setSendError(null)
    try {
      await props.onSend(
        content,
        agentTemplateId || undefined,
        attachments.images.map((image) => image.file),
      )
      setDraft('')
      attachments.clear()
      setSlashIndex(0)
      setSlashDismissed(false)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '发送失败，请重试')
    } finally {
      setSending(false)
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
      <ImageAttachments
        images={attachments.images}
        disabled={sending}
        onRemove={attachments.remove}
      />
      {(attachments.error || sendError) && (
        <div className="composer-image-error" role="alert">
          {attachments.error || sendError}
        </div>
      )}
      {attachments.images.length > 0 && (
        <div className="composer-image-hint">
          请使用支持视觉的模型 · 最多 4 张，每张 4MB
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        disabled={props.disabled || sending}
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          attachments.add(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder={props.placeholder}
        disabled={props.disabled || sending}
        onPaste={(event) => {
          if (sending || props.disabled) return
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.type.startsWith('image/'))
            .flatMap((item) => {
              const file = item.getAsFile()
              return file ? [file] : []
            })
          if (files.length) {
            event.preventDefault()
            attachments.add(files)
          }
        }}
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
          if (isComposing(event.nativeEvent)) return
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
            title={
              props.permissionValue !== undefined
                ? PERMISSION_PRESET_HINTS[props.permissionValue]
                : ''
            }
          >
            <ShieldIcon />
            <Select
              aria-label="权限档位"
              value={props.permissionValue}
              onValueChange={(value) =>
                props.onPermissionChange?.(value as PermissionPreset)
              }
            >
              <option value="workspace-read">
                {PERMISSION_PRESET_LABELS['workspace-read']}
              </option>
              <option value="workspace-write">
                {PERMISSION_PRESET_LABELS['workspace-write']}
              </option>
              <option value="workspace-full">
                {PERMISSION_PRESET_LABELS['workspace-full']}
              </option>
            </Select>
            <ChevronIcon />
          </label>
        )}
        {(props.advanced || enabledAgentTemplates.length > 0) && (
          <ComposerRunConfig
            advanced={props.advanced}
            agentTemplates={enabledAgentTemplates}
            agentTemplateId={agentTemplateId}
            onAgentTemplateChange={setAgentTemplateId}
          />
        )}
        {agentTemplateId !== '' && (
          <button
            type="button"
            className="composer-delegation-chip"
            title="清除本次任务的委派模板"
            onClick={() => setAgentTemplateId('')}
          >
            委派：
            {enabledAgentTemplates.find(
              (template) => template.id === agentTemplateId,
            )?.name ?? agentTemplateId}
            <span aria-hidden>×</span>
          </button>
        )}
        <button
          type="button"
          className="ghost composer-attach"
          disabled={props.disabled || sending}
          title="添加图片（最多 4 张，每张 4MB）；请使用支持视觉的模型"
          onClick={() => fileInputRef.current?.click()}
        >
          添加图片
        </button>
        <span className="bar-spacer" />
        {showModelSelect && (
          <ModelSelector
            options={props.modelOptions ?? []}
            selectedKey={props.selectedModelKey ?? null}
            onModelChange={(key) => props.onModelChange?.(key)}
            reasoning={props.reasoningSelection}
          />
        )}
        {props.modelOptions !== undefined &&
          props.modelOptions.length === 0 && (
            <span className="composer-no-model">未配置模型</span>
          )}
        {showStop && props.onStop ? (
          <button
            className="composer-stop"
            aria-label="停止"
            title="停止当前回复（队列将暂停，稍后需确认继续发送）"
            onClick={() => void props.onStop?.()}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="composer-send"
            aria-label="发送"
            title={busy ? '正在回复，发送的消息将进入队列' : '发送'}
            disabled={props.disabled || !hasDraft || sending}
            onClick={() => void submit()}
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
