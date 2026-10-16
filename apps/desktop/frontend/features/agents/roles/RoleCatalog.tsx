import { RoleBulkDeleteButton } from './bulk/RoleBulkDeleteButton'
import { useState, type ComponentProps } from 'react'
import type { AgentTemplate } from '@reflexion-os-studio/contracts'
import { RoleListItem } from './RoleListItem'

type ItemProps = Omit<
  ComponentProps<typeof RoleListItem>,
  'template' | 'selected' | 'onSelect'
>
const PAGE_SIZE = 10

export function RoleCatalog({
  items,
  itemProps,
  onBulkEdit,
  deletion,
}: {
  items: AgentTemplate[]
  itemProps: ItemProps
  onBulkEdit: (roles: AgentTemplate[]) => void
  deletion: Omit<ComponentProps<typeof RoleBulkDeleteButton>, 'roles' | 'busy'>
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages)
  const shown = items.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )
  const eligible = items.filter((role) => !role.builtin)
  const chosen = eligible.filter((role) => selected.includes(role.id))
  const pageEligible = shown.filter((role) => !role.builtin)
  const pageChecked =
    pageEligible.length > 0 &&
    pageEligible.every((role) => selected.includes(role.id))
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )
  return (
    <>
      <div className="role-catalog-toolbar">
        <label className="agent-checkbox">
          <input
            type="checkbox"
            disabled={itemProps.busy || !pageEligible.length}
            checked={pageChecked}
            onChange={() =>
              setSelected((current) =>
                pageChecked
                  ? current.filter(
                      (id) => !pageEligible.some((role) => role.id === id),
                    )
                  : [
                      ...new Set([
                        ...current,
                        ...pageEligible.map((role) => role.id),
                      ]),
                    ],
              )
            }
          />
          选择本页自定义角色
        </label>
        <button
          type="button"
          disabled={itemProps.busy || !eligible.length || eligible.length > 500}
          onClick={() => setSelected(eligible.map((role) => role.id))}
        >
          选择筛选结果（{eligible.length}）
        </button>
        <span>已选 {chosen.length} 个</span>
        <button
          type="button"
          disabled={itemProps.busy || !chosen.length}
          onClick={() => setSelected([])}
        >
          清除选择
        </button>
        <button
          type="button"
          disabled={itemProps.busy || !chosen.length || chosen.length > 500}
          onClick={() => onBulkEdit(chosen)}
        >
          批量修改
        </button>
        <RoleBulkDeleteButton
          {...deletion}
          roles={chosen}
          busy={itemProps.busy}
        />
      </div>
      <small className="role-catalog-hint">
        内置角色请先复制后配置；可按分类筛选后选择整组。每次批量最多 500 个。
      </small>
      <div className="agent-role-list">
        {shown.map((template) => (
          <RoleListItem
            key={template.id}
            {...itemProps}
            template={template}
            selected={selected.includes(template.id)}
            onSelect={() => toggle(template.id)}
          />
        ))}
      </div>
      {items.length > PAGE_SIZE && (
        <nav className="role-pagination" aria-label="角色分页">
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <span role="status">
            第 {currentPage} / {pages} 页 · 每页最多 10 个 · 共 {items.length}{' '}
            个
          </span>
          <button
            type="button"
            disabled={currentPage === pages}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </nav>
      )}
    </>
  )
}
