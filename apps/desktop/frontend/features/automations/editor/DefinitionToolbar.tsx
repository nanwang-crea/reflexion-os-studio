import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { WorkflowVersion } from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../../components/ConfirmDialog'
import { Select } from '../../../components/forms/Select'
import { archiveWorkflow } from '../../../api/workflow'
import type { useWorkflowEditor } from '../useWorkflowEditor'

export function DefinitionToolbar({
  editor,
  saved,
  select,
  confirm,
}: {
  editor: ReturnType<typeof useWorkflowEditor>
  saved: WorkflowVersion | null | undefined
  select: (
    value: Parameters<ReturnType<typeof useWorkflowEditor>['select']>[0],
  ) => void
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}): React.JSX.Element {
  return (
    <div className="workflow-toolbar">
      <label>
        已保存版本
        <Select
          value={editor.draft?.definitionId ?? editor.base?.definitionId ?? ''}
          disabled={editor.busy}
          onValueChange={(id) =>
            select(
              editor.versions.find((version) => version.definitionId === id) ??
                null,
            )
          }
        >
          <option value="">新流程</option>
          {editor.versions.map((version) => (
            <option key={version.definitionId} value={version.definitionId}>
              {version.definition.name} · v{version.revision}
            </option>
          ))}
        </Select>
      </label>
      <label>
        草稿
        <Select
          value={editor.draft?.id ?? ''}
          disabled={editor.busy}
          onValueChange={(id) =>
            select(editor.drafts.find((draft) => draft.id === id) ?? null)
          }
        >
          <option value="">请选择</option>
          {editor.drafts.map((draft) => (
            <option key={draft.id} value={draft.id}>
              {draft.definition.name} · 草稿 {draft.revision}
            </option>
          ))}
        </Select>
      </label>
      <button type="button" disabled={editor.busy} onClick={() => select(null)}>
        新建
      </button>
      <button
        type="button"
        disabled={editor.busy}
        onClick={() => void editor.saveDraft()}
      >
        保存草稿
      </button>
      <button
        type="button"
        disabled={editor.busy}
        className="workflow-save-version"
        onClick={() => void editor.save()}
      >
        保存版本
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" disabled={editor.busy} aria-label="更多操作">
            更多 ···
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="workflow-more-menu"
            align="end"
            sideOffset={6}
            collisionPadding={8}
          >
            <DropdownMenu.Item
              className="workflow-more-item"
              disabled={editor.busy}
              onSelect={() => void editor.validate()}
            >
              校验
            </DropdownMenu.Item>
            {saved && (
              <DropdownMenu.Item
                className="workflow-more-item"
                disabled={editor.busy}
                onSelect={() =>
                  void editor.action(async () => {
                    if (
                      await confirm({
                        title: '归档工作流',
                        message: `归档 ${saved.definition.name}？运行记录仍可查看。`,
                        confirmLabel: '归档',
                      })
                    ) {
                      const result = await archiveWorkflow({
                        projectId: saved.projectId,
                        definitionId: saved.definitionId,
                        baseRevision: saved.revision,
                      })
                      if (!result.archived)
                        throw new Error('版本已变化，请刷新后操作')
                      await editor.refresh()
                      await editor.select(null)
                    }
                  })
                }
              >
                归档
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="workflow-more-item"
              disabled={editor.busy}
              onSelect={() => void editor.action(editor.refresh)}
            >
              刷新定义
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span>
        {editor.dirty
          ? '有未保存编辑'
          : `草稿 ${editor.draft?.revision ?? '—'}`}
      </span>
    </div>
  )
}
