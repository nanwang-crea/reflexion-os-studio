import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import { Composer } from './Composer'

interface LandingViewProps {
  /** 当前选中的项目；null 表示独立对话模式。 */
  project: Project | null
  /** 选中项目时展示该项目下的历史会话。 */
  sessions: Session[]
  hasEnabledProvider: boolean
  onSend: (content: string) => Promise<void>
  onSelectSession: (sessionId: string) => void
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
                    <button
                      key={session.id}
                      className="landing-session"
                      onClick={() => props.onSelectSession(session.id)}
                    >
                      {session.title}
                    </button>
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
          <Composer
            placeholder={
              !props.hasEnabledProvider
                ? '请先在设置中配置 API Key…'
                : props.project
                  ? `在“${props.project.name}”中开始新会话…`
                  : '输入消息，Enter 发送…'
            }
            disabled={!props.hasEnabledProvider}
            onSend={props.onSend}
          />
        </div>
      </div>
    </div>
  )
}
