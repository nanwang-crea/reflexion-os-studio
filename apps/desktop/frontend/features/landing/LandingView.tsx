import type {
  Project,
  Session,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from '../../components/Composer'
import { SessionRow } from '../../components/SessionRow'

interface LandingViewProps {
  /** 当前选中的项目；null 表示独立对话模式。 */
  project: Project | null
  projects: Project[]
  selectedProjectId: string | null
  onProjectChange: (projectId: string | null) => void
  /** 选中项目时展示该项目下的历史会话。 */
  sessions: Session[]
  hasEnabledProvider: boolean
  permissionValue: string
  onPermissionChange: (value: string) => void
  modelOptions: ComposerModelOption[]
  selectedModelKey: string | null
  onModelChange: (key: string) => void
  /** 可用技能清单：落地页斜杠补全与聊天页共用。 */
  skills: SkillManifest[]
  composerPrefill?: { skillId: string; nonce: number } | null
  onPrefillConsumed?: () => void
  onSend: (content: string) => Promise<void>
  onSelectSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
  onGoSettings: () => void
}

/**
 * 无激活会话时的落地页：直接输入即可开始会话
 * （未选项目 → 独立会话；选中项目 → 该项目下的会话）。
 */
export function LandingView(props: LandingViewProps): React.JSX.Element {
  return (
    <div className="landing">
      <div className="landing-center">
        <div className="landing-content">
          {props.project ? (
            <div className="landing-project">
              <h1 className="landing-title">{props.project.name}</h1>
              <div
                className="landing-path"
                title={props.project.folderPath || '未关联文件夹'}
              >
                {props.project.folderPath || '未关联文件夹'}
              </div>
              {props.sessions.length > 0 && (
                <div className="landing-sessions">
                  {props.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={false}
                      onSelect={() => props.onSelectSession(session.id)}
                      onRename={(title) =>
                        props.onRenameSession(session.id, title)
                      }
                      onDelete={() => props.onDeleteSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="landing-hero">
              <h1 className="landing-title">有什么可以帮你？</h1>
              <p className="landing-hint">
                直接输入开始一段独立对话；或在左侧选择项目，在项目文件夹的上下文中对话。
              </p>
            </div>
          )}
          {!props.hasEnabledProvider && (
            <div className="inline-banner">
              <span>
                尚未配置模型 Provider：请先在设置中填写 API Key 后再开始对话。
              </span>
              <button className="ghost" onClick={props.onGoSettings}>
                去配置
              </button>
            </div>
          )}
          <div className="landing-context-selectors">
            <label className="composer-select" title="新会话项目">
              <span>项目</span>
              <select
                value={props.selectedProjectId ?? ''}
                onChange={(event) =>
                  props.onProjectChange(event.target.value || null)
                }
              >
                <option value="">独立对话</option>
                {props.projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <span>⌄</span>
            </label>
          </div>
          <Composer
            autoFocus
            placeholder={
              !props.hasEnabledProvider
                ? '请先在设置中配置 API Key…'
                : props.project
                  ? `在“${props.project.name}”中开始新会话…`
                  : '输入消息，Enter 发送…'
            }
            disabled={!props.hasEnabledProvider}
            permissionValue={props.permissionValue}
            onPermissionChange={props.onPermissionChange}
            modelOptions={props.modelOptions}
            selectedModelKey={props.selectedModelKey}
            onModelChange={props.onModelChange}
            skills={props.skills}
            prefill={props.composerPrefill ?? null}
            onSend={props.onSend}
          />
        </div>
      </div>
    </div>
  )
}
