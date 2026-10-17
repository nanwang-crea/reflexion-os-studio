import './browser-menu.css'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BrowserIcon } from './BrowserIcon'

/** Radix owns portal placement, keyboard navigation and focus restoration. */
export function BrowserMenu({
  open,
  onOpenChange,
  available,
  credentialsAvailable,
  onImport,
  onNewTab,
  onClear,
  onFind,
  onPrint,
  onZoom,
  onSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  available: boolean
  credentialsAvailable: boolean
  onImport: () => void
  onNewTab: () => void
  onClear: () => void
  onFind: () => void
  onPrint: () => void
  onZoom: (factor: number) => void
  onSettings: () => void
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
          {[0.75, 1, 1.25, 1.5, 2].map((factor) => (
            <DropdownMenu.Item
              key={factor}
              className="browser-menu-item"
              disabled={!available}
              onSelect={() => onZoom(factor)}
            >
              缩放 {factor * 100}%
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="browser-menu-separator" />
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onFind}
          >
            在页面中查找
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onPrint}
          >
            打印
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="browser-menu-separator" />
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available || !credentialsAvailable}
            onSelect={onImport}
          >
            导入 Cookie 和密码…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available || !credentialsAvailable}
            onSelect={onImport}
          >
            密码管理与手动填充…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            onSelect={onSettings}
          >
            下载与浏览器设置…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            onSelect={onSettings}
          >
            历史记录与浏览数据…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="browser-menu-item"
            disabled={!available}
            onSelect={onClear}
          >
            关闭浏览会话
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="browser-menu-separator" />
          <div className="browser-menu-note">
            浏览数据按会话设置保留。历史与网站数据在设置中管理。已导入密码需单独删除。
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
