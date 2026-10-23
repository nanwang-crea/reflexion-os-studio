import { Children, isValidElement, useState, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { ChevronIcon } from '../../ui/icons'
import './controls.css'

interface Props {
  id?: string
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
  icon?: ReactNode
  'aria-label'?: string
}

// option / optgroup 仅作为声明数据，不渲染为原生下拉菜单。
function renderOptions(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (
      !isValidElement<{
        value?: string
        label?: string
        disabled?: boolean
        children?: ReactNode
      }>(child)
    )
      return null
    if (child.type === 'optgroup') {
      return (
        <SelectPrimitive.Group>
          <SelectPrimitive.Label className="ui-select-group">
            {child.props.label}
          </SelectPrimitive.Label>
          {renderOptions(child.props.children)}
        </SelectPrimitive.Group>
      )
    }
    return (
      <SelectPrimitive.Item
        className="ui-select-item"
        value={`item:${child.props.value ?? ''}`}
        disabled={child.props.disabled}
      >
        <SelectPrimitive.ItemText>
          {child.props.children}
        </SelectPrimitive.ItemText>
        <SelectPrimitive.ItemIndicator className="ui-select-check">
          ✓
        </SelectPrimitive.ItemIndicator>
      </SelectPrimitive.Item>
    )
  })
}

export function Select(props: Props) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  return (
    <SelectPrimitive.Root
      value={`item:${props.value}`}
      onValueChange={(value) => props.onValueChange(value.slice(5))}
      disabled={props.disabled}
    >
      <SelectPrimitive.Trigger
        ref={setTrigger}
        id={props.id}
        className="ui-select"
        aria-label={props['aria-label']}
      >
        {props.icon && <span className="ui-select-icon">{props.icon}</span>}
        <span className="ui-select-value">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon className="ui-select-arrow">
          <ChevronIcon />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal
        container={trigger?.closest('dialog') ?? undefined}
      >
        <SelectPrimitive.Content
          className="ui-select-menu"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          onMouseDown={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <SelectPrimitive.ScrollUpButton className="ui-select-scroll">
            <span className="ui-select-scroll-up">
              <ChevronIcon />
            </span>
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {renderOptions(props.children)}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="ui-select-scroll">
            <ChevronIcon />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
