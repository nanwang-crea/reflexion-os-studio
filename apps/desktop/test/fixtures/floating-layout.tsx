import { useState } from 'react'
import { BranchPicker } from '../../frontend/features/workspace/git/BranchPicker'
import { GitHistoryRow } from '../../frontend/features/workspace/git/GitHistoryRow'
import { ComposerRunConfig } from '../../frontend/components/ComposerRunConfig'
import { ConfirmDialog } from '../../frontend/components/ConfirmDialog'

const noop = () => {}

export function FloatingLayout() {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [result, setResult] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  return (
    <div className="app-shell">
      <aside className="sidebar" style={{ width: expanded ? 360 : 200 }}>
        <div className="project-files-body">
          <div className="git-changes">
            <div className="git-changes-head">
              <BranchPicker
                branch="main"
                ahead={0}
                behind={0}
                branches={['main', 'feature/test']}
                remoteBranches={['origin/main']}
                remotes={[]}
                busy={false}
                onSwitch={setResult}
                onCreate={(name) => setResult(name)}
                onRemoteAdd={async () => true}
                onRemoteRemove={async () => true}
                onRefresh={noop}
              />
            </div>
            <ul className="git-hist-list" style={{ marginTop: 480 }}>
              <GitHistoryRow
                commit={
                  {
                    hash: 'abc123',
                    shortHash: 'abc',
                    subject: '布局验证',
                    authorName: 'test',
                    timestampMs: Date.now(),
                    isMerge: false,
                  } as never
                }
                busy={false}
                menuOpen={historyOpen}
                expanded={false}
                files={[]}
                formOpen={formOpen}
                onToggle={noop}
                onMenuToggle={() => setHistoryOpen((open) => !open)}
                onMenuClose={() => setHistoryOpen(false)}
                onOpenForm={() => {
                  setResult('branch-form')
                  setHistoryOpen(false)
                  setFormOpen(true)
                }}
                onCheckout={() => {
                  setResult('checkout')
                  setHistoryOpen(false)
                }}
                onBranchCreate={noop}
                onOpenFile={noop}
              />
            </ul>
          </div>
        </div>
      </aside>
      <div className="main-pane">
        <button onClick={() => setExpanded((value) => !value)}>
          调整侧栏宽度
        </button>
        <button onClick={() => setDialog(true)}>打开确认框</button>
        <ComposerRunConfig
          agentTemplates={[
            { id: 'template', name: '布局验收模板', enabled: true } as never,
          ]}
          agentTemplateId=""
          onAgentTemplateChange={setResult}
          advanced={{
            approvalOverride: 'default',
            onApprovalOverrideChange: noop,
            dangerActive: false,
            onOpenDanger: noop,
          }}
        />
        <output id="floating-result">{result}</output>
      </div>
      <ConfirmDialog
        state={
          dialog
            ? {
                title: 'Confirmation'.repeat(80),
                message: '确认操作的详细说明\n'.repeat(80),
                tertiaryLabel: '不保存并继续',
              }
            : null
        }
        onConfirm={() => setDialog(false)}
        onCancel={() => setDialog(false)}
        onTertiary={() => setDialog(false)}
      />
    </div>
  )
}
