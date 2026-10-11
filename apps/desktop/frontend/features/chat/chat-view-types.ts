import type { ReasoningSelection } from '../../components/composer/ModelSelector'
import type {
  ResourceLink,
  SkillManifest,
  Delegation,
  AgentTemplate,
  PermissionPreset,
  DangerAccessLease,
  UserQuestionAnswer,
} from '@reflexion-os-studio/runtime-client'
import type {
  ComposerModelOption,
  ComposerAdvancedState,
} from '../../components/Composer'
import type { SessionData } from '../../api/sessions'
import type {
  PendingApproval,
  PendingInteraction,
} from '../../hooks/useAppBootstrap'
import type { RunActivity } from '../../hooks/session/useRunActivity'

export interface ChatViewProps {
  sessionData: SessionData | null
  onLoadOlder: (
    sessionId: string,
    before: import('@reflexion-os-studio/runtime-client').HistoryCursor,
  ) => Promise<void>
  delegations: Delegation[]
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  /** Run 级活动阶段（事件驱动，对齐 Codex）：决定状态行文案与折叠。 */
  runActivities: Record<string, RunActivity>
  hasEnabledProvider: boolean
  permissionValue: PermissionPreset
  onPermissionChange: (value: PermissionPreset) => void
  advanced: ComposerAdvancedState
  /** Danger 租约（Runtime 真源投影）：激活时 Composer 上方常驻红色状态条。 */
  dangerLease: DangerAccessLease | null
  onDisableDanger: () => void
  modelOptions: ComposerModelOption[]
  reasoningSelection?: ReasoningSelection
  selectedModelKey: string | null
  onModelChange: (key: string) => void
  skills: SkillManifest[]
  agentTemplates: AgentTemplate[]
  composerPrefill?: { skillId: string; nonce: number } | null
  onPrefillConsumed?: () => void
  onSend: (
    content: string,
    agentTemplateId?: string,
    images?: File[],
  ) => Promise<void>
  onStop: () => Promise<void>
  onRetry: () => Promise<void>
  onGoSettings: () => void
  onExecutionModeChange: (mode: 'execute' | 'plan') => Promise<void>
  pendingApprovals: PendingApproval[]
  onResolveApproval: (toolCallId: string, choiceId: string) => void
  pendingInteractions: PendingInteraction[]
  onInteractionSubmit: (
    interactionId: string,
    answers: UserQuestionAnswer[],
  ) => Promise<boolean>
  /** 点击已变更文件：有编辑前后快照时展示本次编辑 Diff。 */
  onOpenDiff?: (
    path: string,
    options: {
      source: 'chat'
      before?: string
      after?: string
      oldPath?: string
    },
  ) => void
  /** 编辑最后一条用户消息的回调：提交后由 Runtime 处理 superseded 与新 Run 创建。 */
  onEditResend: (messageId: string, content: string) => Promise<void>
  /** 资源引用（工作区文件/资产/外链）点击后按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
}
