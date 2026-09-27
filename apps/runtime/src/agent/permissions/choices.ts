import type {
  ApprovalSubject,
  SandboxPolicy,
  ShellInterpreter,
  ToolOperation,
} from '@reflexion-os-studio/contracts'
import { isToolOperation } from './presets.js'
import type { ApprovalScope } from './types.js'
import type { ChoiceSpec } from './approval-gateway.js'

/** 内置操作 → 会话规则 choice 的文案（§8.2 表）。 */
const PATH_RULE_LABELS: Partial<Record<ToolOperation, string>> = {
  'file.read': '本会话允许读取此文件',
  'file.list': '本会话允许列出此目录',
  'file.glob': '本会话允许本次 pattern',
  'file.grep': '本会话允许本次搜索范围',
  'file.write': '本会话允许写入此文件',
  'file.write_stream': '本会话允许分块写入此文件',
  'file.mkdir': '本会话允许创建此目录',
}

/**
 * 依主题与档位生成 Runtime 认可的 choices（deny 恒有，once 恒有）。
 * delete/move 与复合 Shell 不提供 session choice；file.edit 提供
 * read+edit 原子组合规则；简单 Shell 提供 prefix 规则（含约束说明）。
 */
export function buildApprovalChoices(input: {
  toolName: string
  subject: ApprovalSubject
  sandbox: SandboxPolicy
  network: boolean
  escalation: boolean
  scope: ApprovalScope
  /** Shell prefix 匹配维度（cwd/interpreter），非 Shell 省略。 */
  shell?: { cwd: string; interpreter: ShellInterpreter; prefix: string[] }
}): ChoiceSpec[] {
  const once: ChoiceSpec = {
    choice: {
      id: 'allow-once',
      decision: 'approved',
      presentation: 'primary',
      label: '允许一次',
    },
    effect: { kind: 'once' },
  }
  const deny: ChoiceSpec = {
    choice: {
      id: 'deny',
      decision: 'denied',
      presentation: 'secondary',
      label: '拒绝',
    },
    effect: { kind: 'deny' },
  }
  const choices: ChoiceSpec[] = [once]

  // §6.2：read-only 档的 Shell 审批若需要写能力，choice 必须显式携带
  // workspace-write（审批不隐式升级沙箱）。
  if (input.toolName === 'shell.execute' && input.sandbox === 'read-only') {
    choices.push({
      choice: {
        id: 'allow-once-workspace-write',
        decision: 'approved',
        presentation: 'primary',
        label: '允许一次（工作区可写）',
        description: '本次命令将在可写沙箱中执行；机密路径仍不可读写',
      },
      effect: { kind: 'once', sandboxOverride: 'workspace-write' },
    })
  }

  if (input.subject.kind === 'workspace-path') {
    const { operation, path } = input.subject
    if (operation === 'file.edit') {
      choices.push({
        choice: {
          id: 'session:file.edit',
          decision: 'approved',
          presentation: 'session-menu',
          label: '本会话允许读取并编辑此文件',
          description: `仅工作区内 ${path}；先读后写保护不变`,
        },
        effect: {
          kind: 'session-rules',
          rules: [
            { kind: 'workspace-path', operation: 'file.read', path },
            { kind: 'workspace-path', operation: 'file.edit', path },
          ],
        },
      })
    } else if (operation === 'file.delete' || operation === 'file.move') {
      // 删除/移动保持逐次审批（前三档）；不提供会话规则。
    } else {
      const label = PATH_RULE_LABELS[operation] ?? null
      if (label !== null) {
        choices.push({
          choice: {
            id: `session:${operation}`,
            decision: 'approved',
            presentation: 'session-menu',
            label,
            description: `仅工作区内 ${path}，仅当前会话`,
          },
          effect: {
            kind: 'session-rules',
            rules: [{ kind: 'workspace-path', operation, path }],
          },
        })
      }
    }
  } else if (input.subject.kind === 'shell-command' && input.shell) {
    const prefix = input.subject.prefixCandidate
    if (prefix !== null && !input.escalation && !input.network) {
      const shown = prefix.join(' ')
      choices.push({
        choice: {
          id: 'session:shell-prefix',
          decision: 'approved',
          presentation: 'session-menu',
          label: `本会话允许 "${shown}"`,
          description: `仅限工作目录 ${input.shell.cwd === '.' ? '工作区根' : input.shell.cwd}、沙箱档位 ${input.sandbox} 且不联网`,
        },
        effect: {
          kind: 'session-rules',
          rules: [
            {
              kind: 'shell-prefix',
              interpreter: input.shell.interpreter,
              cwd: input.shell.cwd,
              prefix,
              sandbox:
                input.sandbox === 'danger' ? 'workspace-write' : input.sandbox,
              network: false,
            },
          ],
        },
      })
    }
  } else if (
    input.subject.kind === 'operation' &&
    !input.escalation &&
    // file.move 等内置操作走一次性审批语义，不给 operation 级会话授权。
    !isToolOperation(input.toolName)
  ) {
    // MCP/未知工具：保持 operation 级会话授权（本期不加资源语义）。
    // 网络授权不走此分支（W6）：由 buildNetworkChoices 绑定 shell 前缀规则。
    choices.push({
      choice: {
        id: 'session:operation',
        decision: 'approved',
        presentation: 'session-menu',
        label: `本会话允许 ${input.subject.operation}`,
        description: '仅当前会话，重启后失效',
      },
      effect: { kind: 'session-operation', operation: input.subject.operation },
    })
  }
  choices.push(deny)
  return choices
}

/**
 * 独立网络审批卡的 choices（W6）：once 网络批准只进当前精确调用 grant；
 * session 复用只能落成"同一 shell 前缀规则 + network=true"——没有可验证
 * 前缀的复合命令永远给不出会话网络授权（批准 git fetch 不能放行 curl）。
 */
export function buildNetworkChoices(input: {
  scope: ApprovalScope
  sandbox: SandboxPolicy
  cwd: string
  interpreter: ShellInterpreter
  prefixCandidate: string[] | null
  displayCommand: string
}): ChoiceSpec[] {
  const choices: ChoiceSpec[] = [
    {
      choice: {
        id: 'allow-once',
        decision: 'approved',
        presentation: 'primary',
        label: '允许本次联网',
      },
      effect: { kind: 'once' },
    },
  ]
  if (input.prefixCandidate !== null && input.sandbox !== 'danger') {
    const shown = input.prefixCandidate.join(' ')
    choices.push({
      choice: {
        id: 'session:network-prefix',
        decision: 'approved',
        presentation: 'session-menu',
        label: `本会话允许 "${shown}" 联网`,
        description: `仅限该命令前缀、工作目录 ${input.cwd === '.' ? '工作区根' : input.cwd} 与档位 ${input.sandbox}；不放行其它命令`,
      },
      effect: {
        kind: 'session-rules',
        rules: [
          {
            kind: 'shell-prefix',
            interpreter: input.interpreter,
            cwd: input.cwd,
            prefix: input.prefixCandidate,
            sandbox: input.sandbox,
            network: true,
          },
        ],
      },
    })
  }
  choices.push({
    choice: {
      id: 'deny',
      decision: 'denied',
      presentation: 'secondary',
      label: '拒绝联网',
    },
    effect: { kind: 'deny' },
  })
  return choices
}
