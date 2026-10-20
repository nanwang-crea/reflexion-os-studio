import type { ComposerProps } from '../Composer'
import type {
  AgentTemplate,
  PermissionPreset,
} from '@reflexion-os-studio/runtime-client'
import { Select } from '../forms/Select'
import { ChevronIcon, SendIcon, ShieldIcon, StopIcon } from '../../ui/icons'
import {
  PERMISSION_PRESET_HINTS,
  PERMISSION_PRESET_LABELS,
} from '../../hooks/permissions/usePermissionPreset'
import { ComposerRunConfig } from '../ComposerRunConfig'
import { ComposerActionsMenu } from './ComposerActionsMenu'
import { ModelSelector } from './ModelSelector'

type Props = Pick<
  ComposerProps,
  | 'disabled'
  | 'busy'
  | 'advanced'
  | 'permissionValue'
  | 'onPermissionChange'
  | 'modelOptions'
  | 'selectedModelKey'
  | 'onModelChange'
  | 'reasoningSelection'
  | 'onStop'
> & {
  enabledAgentTemplates: AgentTemplate[]
  agentTemplateId: string
  onAgentTemplateChange: (id: string) => void
  sending: boolean
  hasDraft: boolean
  showStop: boolean
  onChooseFiles: () => void
  onSubmit: () => void
}

export function ComposerToolbar(props: Props): React.JSX.Element {
  const showModelSelect = Boolean(
    props.modelOptions?.length && props.onModelChange,
  )
  return (
    <div className="composer-bar">
      <div className="composer-controls">
        <ComposerActionsMenu
          disabled={Boolean(props.disabled || props.sending)}
          onChooseFiles={props.onChooseFiles}
        />
        {(props.advanced || props.enabledAgentTemplates.length > 0) && (
          <ComposerRunConfig
            disabled={Boolean(props.disabled || props.sending)}
            advanced={props.advanced}
            agentTemplates={props.enabledAgentTemplates}
            agentTemplateId={props.agentTemplateId}
            onAgentTemplateChange={props.onAgentTemplateChange}
          />
        )}
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
        {props.agentTemplateId !== '' && (
          <button
            type="button"
            className="composer-delegation-chip"
            title="清除本次任务的委派模板"
            onClick={() => props.onAgentTemplateChange('')}
          >
            委派：
            {props.enabledAgentTemplates.find(
              (template) => template.id === props.agentTemplateId,
            )?.name ?? props.agentTemplateId}
            <span aria-hidden>×</span>
          </button>
        )}
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
      </div>
      {props.showStop && props.onStop ? (
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
          className={`composer-send${props.busy ? ' queued' : ''}`}
          aria-label={props.busy ? '加入队列' : '发送'}
          title={props.busy ? '回复完成后自动发送' : '发送'}
          disabled={props.disabled || !props.hasDraft || props.sending}
          onClick={props.onSubmit}
        >
          {props.busy && <span>加入队列</span>}
          <SendIcon />
        </button>
      )}
    </div>
  )
}
