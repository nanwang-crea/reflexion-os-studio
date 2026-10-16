import * as ContextMenu from '@radix-ui/react-context-menu'
import { useRef, type ReactNode, type RefObject } from 'react'
import './session-context-menu.css'

export function SessionContextMenu({
  children,
  title,
  editing,
  busy,
  returnFocus,
  onImport,
  onExport,
  onRename,
  onDelete,
}: {
  children: ReactNode
  title: string
  editing: boolean
  busy: boolean
  returnFocus: RefObject<HTMLButtonElement | null>
  onImport?: () => void
  onExport?: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const interactedOutside = useRef(false)
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) interactedOutside.current = false
      }}
    >
      <ContextMenu.Trigger
        asChild
        disabled={editing}
        onKeyDown={(event) => {
          if (
            editing ||
            (event.key !== 'ContextMenu' &&
              !(event.shiftKey && event.key === 'F10'))
          )
            return
          event.preventDefault()
          // WebViews differ in whether these keys produce a native contextmenu event.
          const rect = event.currentTarget.getBoundingClientRect()
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + 12,
              clientY: rect.bottom,
            }),
          )
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="session-context-menu"
          collisionPadding={8}
          onInteractOutside={() => {
            interactedOutside.current = true
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (!interactedOutside.current && returnFocus.current?.isConnected)
              returnFocus.current.focus()
          }}
        >
          <ContextMenu.Label className="session-context-label">
            {title}
          </ContextMenu.Label>
          {onImport && (
            <ContextMenu.Item
              className="session-context-item"
              disabled={busy}
              onSelect={() => {
                returnFocus.current?.focus()
                onImport()
              }}
            >
              导入聊天记录…
            </ContextMenu.Item>
          )}
          {onExport && (
            <ContextMenu.Item
              className="session-context-item"
              disabled={busy}
              onSelect={() => {
                returnFocus.current?.focus()
                onExport()
              }}
            >
              导出聊天记录…
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="session-context-separator" />
          <ContextMenu.Item
            className="session-context-item"
            onSelect={onRename}
          >
            重命名会话
          </ContextMenu.Item>
          <ContextMenu.Item
            className="session-context-item danger"
            onSelect={onDelete}
          >
            删除会话
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
