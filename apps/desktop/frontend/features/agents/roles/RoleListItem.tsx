import type {
  AgentTemplate,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import type { RoleDraft } from './RoleEditor'

function roleModelLabel(
  template: AgentTemplate,
  profiles: ProviderProfile[],
): string {
  const binding = template.modelBinding
  return binding.mode === 'inherit'
    ? '继承上级模型与思考等级'
    : `${profiles.find((profile) => profile.id === binding.providerId)?.name ?? binding.providerId} / ${binding.model}`
}

export function RoleListItem({
  template,
  profiles,
  projects,
  busy,
  scope,
  initialProjectId,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onToggle,
}: {
  selected?: boolean
  onSelect?: () => void
  template: AgentTemplate
  profiles: ProviderProfile[]
  projects: Project[]
  busy: boolean
  scope: string
  initialProjectId: string | null
  onEdit: (value: RoleDraft) => void
  onDelete: (template: AgentTemplate) => void
  onToggle: (template: AgentTemplate) => void
}): React.JSX.Element {
  return (
    <article
      className={`agent-role-card${selected ? ' is-selected' : ''}`}
      key={template.id}
    >
      <div className="agent-role-identity">
        <header>
          {onSelect && (
            <input
              type="checkbox"
              aria-label={`选择 ${template.name}`}
              title={template.builtin ? '内置角色请先复制后配置' : undefined}
              disabled={busy || template.builtin}
              checked={selected ?? false}
              onChange={onSelect}
            />
          )}
          <strong>{template.name}</strong>
          <span>
            {template.builtin ? '内置' : template.projectId ? '项目' : '全局'}
          </span>
        </header>
        <p>{template.description}</p>
      </div>
      <div className="agent-role-details">
        <small>
          {template.domains.join(' · ') || '通用'} ·{' '}
          {roleModelLabel(template, profiles)}
        </small>
        <small>
          位置：
          {template.projectId
            ? (projects.find((project) => project.id === template.projectId)
                ?.name ?? '原项目不可用')
            : '全局'}{' '}
          · {template.policy.allowedTools.length} 个工具 ·{' '}
          {template.policy.canDelegate ? '允许继续委派' : '独立执行'}
        </small>
      </div>
      <footer>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onEdit({
              id: template.builtin ? undefined : template.id,
              name: template.builtin
                ? `${template.name}（自定义）`
                : template.name,
              description: template.description,
              systemPrompt: template.systemPrompt,
              projectId: template.builtin
                ? scope === '*'
                  ? initialProjectId
                  : scope || null
                : template.projectId,
              domains: template.domains,
              modelBinding: template.modelBinding,
              enabled: template.enabled,
              permissionCeiling: template.policy.permissionCeiling,
              canDelegate: template.policy.canDelegate,
              allowedTools: template.policy.allowedTools,
            })
          }
        >
          {template.builtin ? '复制并配置' : '编辑'}
        </button>
        {!template.builtin && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(template)}
          >
            删除
          </button>
        )}
        <label className="agent-checkbox">
          <input
            type="checkbox"
            aria-label={`启用 ${template.name}`}
            checked={template.enabled}
            disabled={busy}
            onChange={() => onToggle(template)}
          />
          启用
        </label>
      </footer>
    </article>
  )
}
