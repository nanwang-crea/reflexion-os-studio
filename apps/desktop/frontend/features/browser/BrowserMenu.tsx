import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BrowserIcon } from './BrowserIcon'

/** Radix owns portal placement, keyboard navigation and focus restoration. */
export function BrowserMenu({
  open,
  onOpenChange,
  available,
  onImport,
  onNewTab,
  onClear,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  available: boolean
  onImport: () => void
  onNewTab: () => void
  onClear: () => void
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="browser-icon-button browser-external"
          aria-label="浏览器菜单"
          title="浏览器菜单"
        >
          <BrowserIcon name="more" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="browser-menu"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onNewTab}
          >
            新标签页
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="browser-menu-separator" />
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled
            title="尚未开放"
          >
            在页面中查找（尚未开放）
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled
            title="尚未开放"
          >
            打印（尚未开放）
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="browser-menu-separator" />
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onImport}
          >
            导入 Cookie 和密码…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onImport}
          >
            密码管理与手动填充…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="browser-menu-item" disabled>
            下载（尚未开放）
          </DropdownMenu.Item>
          <DropdownMenu.Item className="browser-menu-item" disabled>
            历史记录（尚未开放）
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onClear}
          >
            清除临时浏览数据
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="browser-menu-separator" />
          <div className="browser-menu-note">
            浏览数据仅保留在当前临时会话中。已导入密码需在密码管理中单独删除。
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
