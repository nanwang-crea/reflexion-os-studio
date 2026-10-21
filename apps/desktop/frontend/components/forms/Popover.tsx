import { useState, type ReactElement, type ReactNode } from 'react'
import * as Primitive from '@radix-ui/react-popover'
import './popover.css'

/** 带表单的非模态浮层：脱离裁剪容器，随锚点移动并处理视口碰撞。 */
export function Popover(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  children: ReactNode
  label: string
  className: string
  side?: 'top' | 'bottom'
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  return (
    <Primitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Primitive.Trigger asChild ref={setTrigger}>
        {props.trigger}
      </Primitive.Trigger>
      <Primitive.Portal container={trigger?.closest('dialog') ?? undefined}>
        <Primitive.Content
          className={`ui-popover ${props.className}`}
          side={props.side ?? 'bottom'}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={props.label}
        >
          {props.children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
