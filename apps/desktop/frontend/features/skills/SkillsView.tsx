import { useEffect, useState } from 'react'
import type {
  Session,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { SparkIcon } from '../../ui/icons'
import { createSession } from '../../api/sessions'
import { listSkills } from '../../api/skills'

interface SkillsViewProps {
  /** 点击“在对话中使用”：创建独立会话并跳回 chat，Composer 预填 /<id> 。 */
  onUseSkill: (skillId: string, sessionId: string) => void
}

/**
 * 技能 / 插件市场：Phase 1A 只展示内置技能，第三方 install/enable 属 Phase 2。
 * 启动对话后会回切 chat 视图，把 /<skillId> 预填到 Composer。
 */
export function SkillsView(props: SkillsViewProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillManifest[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)

  useEffect(() => {
    listSkills()
      .then((result) => setSkills(result.skills))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
  }, [])

  const toggle = (skillId: string): void => {
    setExpanded((current) => ({ ...current, [skillId]: !current[skillId] }))
  }

  const startChat = async (skill: SkillManifest): Promise<void> => {
    setStarting(skill.id)
    try {
      const created: { session: Session } = await createSession(null)
      props.onUseSkill(skill.id, created.session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(null)
    }
  }

  return (
    <div className="skills-view">
      <header className="panel-head">
        <h1>技能 / 插件市场</h1>
        <p className="panel-sub">
          Phase
          1A：内置技能只读清单。第三方技能安装、启用与自动更新将在后续版本开放。
        </p>
      </header>

      {error !== null && <div className="inline-banner error">{error}</div>}

      <div className="skill-grid">
        {skills.map((skill) => (
          <article key={skill.id} className="skill-card">
            <header className="skill-card-head">
              <div className="skill-card-icon" aria-hidden="true">
                <SparkIcon size={18} />
              </div>
              <div className="skill-card-titles">
                <div className="skill-card-name">{skill.name}</div>
                <div className="skill-card-id">
                  /{skill.id}{' '}
                  <span className="skill-card-ver">v{skill.version}</span>
                </div>
              </div>
              <span className="skill-card-tag">内置</span>
            </header>

            <p className="skill-card-desc">{skill.description}</p>

            {skill.argumentHint !== null && (
              <div className="skill-card-hint">
                <span className="skill-card-hint-label">用法</span>
                <code>
                  /{skill.id} {skill.argumentHint}
                </code>
              </div>
            )}

            {skill.tools.length > 0 && (
              <div className="skill-card-tools">
                {skill.tools.map((tool) => (
                  <span key={tool} className="skill-card-tool">
                    {tool}
                  </span>
                ))}
              </div>
            )}

            <div className="skill-card-actions">
              <button
                className="ghost"
                type="button"
                onClick={() => toggle(skill.id)}
              >
                {expanded[skill.id] ? '收起说明' : '查看说明'}
              </button>
              <button
                className="primary"
                type="button"
                disabled={starting === skill.id}
                onClick={() => void startChat(skill)}
              >
                {starting === skill.id ? '创建中…' : '在对话中使用'}
              </button>
            </div>

            {expanded[skill.id] && (
              <div className="skill-card-instructions">
                该技能的完整说明会在新对话中由 Agent 通过 <code>skill.use</code>{' '}
                工具加载到上下文，无需在此处展示。
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
