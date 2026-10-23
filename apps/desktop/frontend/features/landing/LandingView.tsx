import type { ReasoningSelection } from '../../components/composer/ModelSelector'
import { LandingComposerHeader } from './LandingComposerHeader'
import type {
  Project,
  Session,
  SkillManifest,
  AgentTemplate,
} from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from '../../components/Composer'
import { SessionRow } from '../../components/SessionRow'
import type { PermissionPreset } from '@reflexion-os-studio/runtime-client'

interface LandingViewProps {
  /** 当前选中的项目；null 表示独立对话模式。 */
  project: Project | null
  projects: Project[]
  selectedProjectId: string | null
  onProjectChange: (projectId: string | null) => void
  /** 选中项目时展示该项目下的历史会话。 */
  sessions: Session[]
  hasEnabledProvider: boolean
  permissionValue: PermissionPreset
  onPermissionChange: (value: PermissionPreset) => void
  modelOptions: ComposerModelOption[]
  reasoningSelection?: ReasoningSelection
  selectedModelKey: string | null
  onModelChange: (key: string) => void
  /** 可用技能清单：落地页斜杠补全与聊天页共用。 */
  skills: SkillManifest[]
  agentTemplates: AgentTemplate[]
  composerPrefill?: { skillId: string; nonce: number } | null
  onPrefillConsumed?: () => void
  onSend: (
    content: string,
    agentTemplateId?: string,
    images?: File[],
  ) => Promise<void>
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
          <div className="landing-intro">
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
                  描述你的任务，或选择一个项目后开始协作。
                </p>
              </div>
            )}
            {!props.hasEnabledProvider && (
              <div className="inline-banner">
                <span>连接一个模型，即可开始对话。</span>
                <button className="ghost" onClick={props.onGoSettings}>
                  配置模型
                </button>
              </div>
            )}
          </div>
          <LandingComposerHeader
            projects={props.projects}
            selectedProjectId={props.selectedProjectId}
            onProjectChange={props.onProjectChange}
            onGoSettings={props.onGoSettings}
          />
          <Composer
            autoFocus
            placeholder={
              !props.hasEnabledProvider
                ? '请先在设置中配置 API Key…'
                : '随心输入'
            }
            disabled={!props.hasEnabledProvider}
            permissionValue={props.permissionValue}
            onPermissionChange={props.onPermissionChange}
            modelOptions={props.modelOptions}
            reasoningSelection={props.reasoningSelection}
            selectedModelKey={props.selectedModelKey}
            onModelChange={props.onModelChange}
            skills={props.skills}
            agentTemplates={props.agentTemplates}
            prefill={props.composerPrefill ?? null}
            onSend={props.onSend}
          />
        </div>
      </div>
    </div>
  )
}
