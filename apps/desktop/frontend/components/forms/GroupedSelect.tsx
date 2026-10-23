import { useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { ChevronIcon } from '../../ui/icons'
import './controls.css'
import './grouped-select.css'

interface Option {
  key: string
  label: string
}

export function GroupedSelect(props: {
  groups: ReadonlyMap<string, readonly Option[]>
  value: string | null
  onValueChange: (value: string) => void
  'aria-label': string
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const selected = [...props.groups.values()]
    .flat()
    .find((option) => option.key === props.value)
  const container = trigger?.closest('dialog') ?? undefined
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          ref={setTrigger}
          type="button"
          className="ui-select"
          aria-label={props['aria-label']}
          disabled={props.groups.size === 0}
          title={selected?.label}
        >
          <span className="ui-select-value">
            {selected?.label ?? '选择模型'}
          </span>
          <span className="ui-select-arrow" aria-hidden="true">
            <ChevronIcon />
          </span>
        </button>
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Content
          className="ui-grouped-menu"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          {[...props.groups].map(([group, options]) => (
            <Menu.Sub key={group}>
              <Menu.SubTrigger className="ui-grouped-item" title={group}>
                <span className="ui-grouped-label">{group}</span>
                {options.some((option) => option.key === props.value) && (
                  <span aria-hidden="true">✓</span>
                )}
                <span className="ui-grouped-chevron" aria-hidden="true">
                  <ChevronIcon />
                </span>
              </Menu.SubTrigger>
              <Menu.Portal container={container}>
                <Menu.SubContent
                  className="ui-grouped-menu"
                  sideOffset={4}
                  collisionPadding={8}
                >
                  <Menu.RadioGroup
                    value={props.value ?? ''}
                    onValueChange={props.onValueChange}
                  >
                    {options.map((option) => (
                      <Menu.RadioItem
                        key={option.key}
                        value={option.key}
                        className="ui-grouped-item"
                        title={option.label}
                      >
                        <span className="ui-grouped-label">{option.label}</span>
                        <Menu.ItemIndicator>✓</Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.SubContent>
              </Menu.Portal>
            </Menu.Sub>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
