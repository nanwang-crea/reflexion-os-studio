import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FileIcon, PlusIcon } from '../../ui/icons'

export function ComposerActionsMenu(props: {
  disabled: boolean
  onChooseFiles: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="composer-plus-trigger"
          aria-label="添加功能"
          disabled={props.disabled}
          title="添加附件与快捷输入提示"
        >
          <PlusIcon size={17} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="composer-plus-panel"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          <DropdownMenu.Item
            className="composer-plus-item actionable"
            disabled={props.disabled}
            onSelect={props.onChooseFiles}
          >
            <span className="composer-plus-symbol" aria-hidden>
              <FileIcon size={16} />
            </span>
            <span>添加文件</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="composer-plus-divider" />
          <DropdownMenu.Label className="composer-shortcuts">
            <strong>快捷输入</strong>
            <span>
              <kbd>@</kbd> 添加上下文
            </span>
            <span>
              <kbd>/</kbd> 选择能力
            </span>
            <span>
              <kbd>$</kbd> 激活技能
            </span>
            <span>
              <kbd>Shift + Enter</kbd> 换行
            </span>
          </DropdownMenu.Label>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
