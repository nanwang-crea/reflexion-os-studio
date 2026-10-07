import { Select } from './forms/Select'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentTemplate } from '@reflexion-os-studio/runtime-client'
import { SparkIcon } from '../ui/icons'
import type { ComposerAdvancedState } from './Composer'

interface ComposerRunConfigProps {
  advanced?: ComposerAdvancedState
  agentTemplates: AgentTemplate[]
  agentTemplateId: string
  onAgentTemplateChange: (templateId: string) => void
}

/** 本次发送的低频配置：委派策略与会话级高级权限。 */
export function ComposerRunConfig(
  props: ComposerRunConfigProps,
): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = useState({ left: 0, bottom: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 16)
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const enabledTemplates = props.agentTemplates.filter(
    (template) => template.enabled,
  )

  return (
    <div className="composer-run-config" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-run-config-trigger${
          props.advanced?.dangerActive ? ' danger-on' : ''
        }`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="运行配置"
        onClick={() => setOpen((value) => !value)}
      >
        <SparkIcon />
        <span>运行配置</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              left: position.left,
              bottom: position.bottom,
              maxHeight: Math.max(0, window.innerHeight - position.bottom - 8),
            }}
            className="composer-run-config-panel"
            role="dialog"
            aria-label="运行配置"
          >
            {enabledTemplates.length > 0 && (
              <section className="run-config-section">
                <strong>任务委派</strong>
                <small>设置本次任务优先使用的子 Agent 模板。</small>
                <label className="run-config-field">
                  <span>委派策略</span>
                  <Select
                    value={props.agentTemplateId}
                    onValueChange={(value) =>
                      props.onAgentTemplateChange(value)
                    }
                  >
                    <option value="">自动选择</option>
                    {enabledTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </section>
            )}
            {props.advanced && enabledTemplates.length > 0 && (
              <div className="advanced-sep" />
            )}
            {props.advanced && (
              <section className="run-config-section">
                <strong>高级权限</strong>
                <label className="advanced-row">
                  <input
                    type="checkbox"
                    checked={
                      props.advanced.approvalOverride === 'ask-everything'
                    }
                    onChange={(event) =>
                      props.advanced?.onApprovalOverrideChange(
                        event.target.checked ? 'ask-everything' : 'default',
                      )
                    }
                  />
                  <span>
                    所有操作均询问
                    <small>
                      本会话内即使当前档位已允许，也会逐次确认工作区读取、编辑和命令。
                    </small>
                  </span>
                </label>
                <button
                  type="button"
                  className="advanced-danger"
                  disabled={props.advanced.dangerActive}
                  onClick={() => {
                    setOpen(false)
                    props.advanced?.onOpenDanger()
                  }}
                >
                  {props.advanced.dangerActive
                    ? '危险访问已启用（见状态条）'
                    : '危险：系统范围完全访问…'}
                  <small>需要两次明确确认，不支持的平台会拒绝启用。</small>
                </button>
              </section>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
