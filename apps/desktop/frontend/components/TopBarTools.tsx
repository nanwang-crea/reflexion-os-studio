import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FolderIcon, GlobeIcon, TerminalIcon } from '../ui/icons'
import type { TopBarProps } from './TopBar'
import './topbar-tools.css'

/** Only expose implemented panel actions; Radix owns focus and keyboard behavior. */
export function TopBarTools(props: TopBarProps): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="topbar-toggle topbar-more"
          aria-label="对话工具菜单"
          title="对话工具"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="19" cy="12" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="topbar-tools-menu"
          align="end"
          sideOffset={8}
          collisionPadding={8}
        >
          <DropdownMenu.CheckboxItem
            className="topbar-tools-item"
            checked={props.browserOpen}
            onCheckedChange={props.onToggleBrowser}
          >
            <GlobeIcon />
            <span>网页浏览</span>
            <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          {props.showWorkspaceToggle && (
            <DropdownMenu.CheckboxItem
              className="topbar-tools-item"
              checked={props.workspaceOpen}
              onCheckedChange={props.onToggleWorkspace}
            >
              <FolderIcon />
              <span>文件与工作区</span>
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
          )}
          {props.showTerminalToggle && (
            <DropdownMenu.CheckboxItem
              className="topbar-tools-item"
              checked={props.terminalOpen}
              onCheckedChange={props.onToggleTerminal}
            >
              <TerminalIcon />
              <span>终端</span>
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
