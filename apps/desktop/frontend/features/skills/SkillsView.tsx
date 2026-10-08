import { useCallback, useEffect, useState } from 'react'
import type {
  PluginRecord,
  Session,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { SparkIcon } from '../../ui/icons'
import { createSession } from '../../api/sessions'
import {
  listPlugins,
  listSkills,
  rescanPlugins,
  togglePlugin,
  uninstallPlugin,
} from '../../api/skills'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { PluginInstaller } from './PluginInstaller'
import { usePluginTasks } from './usePluginTasks'
import { PluginUpdateActions } from './PluginUpdateActions'

interface SkillsViewProps {
  onUseSkill: (skillId: string, sessionId: string) => void
}

/** Builtin and declarative external Skill management. */
export function SkillsView(props: SkillsViewProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillManifest[]>([])
  const [plugins, setPlugins] = useState<PluginRecord[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { confirmState, confirm, handleConfirm, handleCancel, handleTertiary } =
    useConfirmDialog()

  const reload = useCallback(async (): Promise<void> => {
    const [skillResult, pluginResult] = await Promise.all([
      listSkills(),
      listPlugins(),
    ])
    setSkills(skillResult.skills)
    setPlugins(pluginResult.plugins)
  }, [])
  const { tasks, remember, cancel } = usePluginTasks(reload, setError)

  useEffect(() => {
    void reload().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [reload])

  const runAction = async (
    id: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      await action()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const startChat = async (
    skill: SkillManifest,
    projectId: string | null,
  ): Promise<void> => {
    setStarting(skill.id)
    try {
      const created: { session: Session } = await createSession(projectId)
      props.onUseSkill(skill.id, created.session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(null)
    }
  }

  const removePlugin = async (plugin: PluginRecord): Promise<void> => {
    const accepted = await confirm({
      title: '卸载技能',
      message: `将删除应用数据目录中的“${plugin.name}”副本。此操作不可撤销。`,
      confirmLabel: '卸载',
      danger: true,
    })
    if (accepted) {
      await runAction(plugin.id, () => uninstallPlugin(plugin.id))
    }
  }

  return (
    <div className="skills-view">
      <header className="panel-head">
        <h1>技能</h1>
        <p className="panel-sub">
          内置技能随应用发布；外部技能从数据目录发现。技能声明的工具不授予权限，
          实际调用仍受当前权限策略与审批约束。
        </p>
        <button
          className="ghost skill-rescan"
          type="button"
          disabled={busy !== null}
          onClick={() => void runAction('rescan', () => rescanPlugins())}
        >
          重新扫描
        </button>
      </header>

      {error !== null && <div className="inline-banner error">{error}</div>}

      <PluginInstaller
        busy={busy !== null}
        onError={setError}
        tasks={tasks}
        rememberTask={remember}
        cancelTask={cancel}
      />

      <div className="skill-grid">
        {plugins.map((plugin) => {
          const skill = skills.find((item) => item.id === plugin.id) ?? {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            tools: plugin.manifest.skill?.tools ?? [],
            argumentHint: plugin.manifest.skill?.argumentHint ?? null,
            whenToUse: plugin.manifest.skill?.whenToUse ?? null,
            license: plugin.manifest.skill?.license ?? null,
            metadata: plugin.manifest.skill?.metadata ?? {},
          }
          const enabled = plugin.enabled && plugin.status === 'enabled'
          const updateTask = Object.values(tasks).find(
            (task) =>
              task.action === 'update' &&
              task.pluginId === plugin.id &&
              !['completed', 'failed', 'cancelled'].includes(task.status),
          )
          return (
            <article key={plugin.id} className="skill-card">
              <header className="skill-card-head">
                <div className="skill-card-icon" aria-hidden="true">
                  <SparkIcon size={18} />
                </div>
                <div className="skill-card-titles">
                  <div className="skill-card-name">{plugin.name}</div>
                  <div className="skill-card-id">
                    ${plugin.id}{' '}
                    <span className="skill-card-ver">v{plugin.version}</span>
                  </div>
                  <div className="skill-card-source">
                    {plugin.source === 'builtin'
                      ? '随应用提供'
                      : plugin.source === 'git'
                        ? 'Git 安装'
                        : plugin.source === 'local'
                          ? '本地安装'
                          : '工作区安装'}
                    {' · '}
                    {plugin.scope === 'project' ? '项目范围' : '全局范围'}
                  </div>
                </div>
                <span className={`skill-card-tag ${plugin.status}`}>
                  {plugin.source === 'builtin'
                    ? '内置'
                    : plugin.status === 'invalid'
                      ? '无效'
                      : enabled
                        ? '已启用'
                        : '已停用'}
                </span>
              </header>

              <p className="skill-card-desc">{plugin.description}</p>
              {skill?.whenToUse != null && (
                <p className="skill-card-desc">触发时机：{skill.whenToUse}</p>
              )}
              {plugin.error !== null && (
                <div className="skill-card-error">{plugin.error}</div>
              )}

              {skill?.argumentHint != null && (
                <div className="skill-card-hint">
                  <span className="skill-card-hint-label">用法</span>
                  <code>
                    ${plugin.id} {skill.argumentHint}
                  </code>
                </div>
              )}

              {skill?.license != null && (
                <div className="skill-card-hint">
                  <span className="skill-card-hint-label">许可证</span>
                  <span>{skill.license}</span>
                </div>
              )}

              {skill !== undefined && skill.tools.length > 0 && (
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
                  onClick={() =>
                    setExpanded((current) => ({
                      ...current,
                      [plugin.id]: !current[plugin.id],
                    }))
                  }
                >
                  {expanded[plugin.id] ? '收起说明' : '查看说明'}
                </button>
                {plugin.source !== 'builtin' && (
                  <>
                    <button
                      className="ghost"
                      type="button"
                      disabled={
                        busy === plugin.id || plugin.status === 'invalid'
                      }
                      onClick={() =>
                        void runAction(plugin.id, () =>
                          togglePlugin(plugin.id, !enabled),
                        )
                      }
                    >
                      {enabled ? '停用' : '启用'}
                    </button>
                    <PluginUpdateActions
                      plugin={plugin}
                      busy={busy === plugin.id}
                      task={updateTask}
                      remember={remember}
                      cancel={cancel}
                      onError={setError}
                    />
                    <button
                      className="ghost danger"
                      type="button"
                      disabled={busy === plugin.id}
                      onClick={() => void removePlugin(plugin)}
                    >
                      卸载
                    </button>
                  </>
                )}
                {enabled && (
                  <button
                    className="primary"
                    type="button"
                    disabled={starting === plugin.id}
                    onClick={() => void startChat(skill, plugin.projectId)}
                  >
                    {starting === plugin.id ? '创建中…' : '在对话中使用'}
                  </button>
                )}
              </div>

              {expanded[plugin.id] && (
                <div className="skill-card-instructions">
                  <p>
                    完整说明会在激活后注入 Agent 上下文，也可由{' '}
                    <code>skill.use</code> 按需加载。
                  </p>
                  <dl className="skill-permissions">
                    <div>
                      <dt>协议兼容</dt>
                      <dd>{plugin.manifest.compatibility.protocol}</dd>
                    </div>
                    <div>
                      <dt>文件权限声明</dt>
                      <dd>{plugin.manifest.permissions.filesystem}</dd>
                    </div>
                    <div>
                      <dt>网络 / Shell</dt>
                      <dd>
                        {plugin.manifest.permissions.network ? '网络 ' : ''}
                        {plugin.manifest.permissions.shell ? 'Shell' : ''}
                        {!plugin.manifest.permissions.network &&
                        !plugin.manifest.permissions.shell
                          ? '无'
                          : ''}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
            </article>
          )
        })}
      </div>
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onTertiary={handleTertiary}
      />
    </div>
  )
}
