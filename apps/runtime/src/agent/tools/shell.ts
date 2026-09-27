import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import {
  callSystem,
  optionalNumber,
  optionalString,
  requireString,
} from './shared.js'
import type { ShellOutputStore } from './shell-output.js'

export function createShellExecuteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  outputStore: ShellOutputStore,
): ToolDefinition {
  return {
    name: 'shell.execute',
    description:
      '在工作区内执行 shell 命令（POSIX sh / Windows cmd），返回退出码与输出。truncated=true 表示 stdout 或 stderr 超过输出上限，需改用更窄的命令范围或分页/重定向到工作区文件后用 file.read 分段读取。cwd 需在工作区内。需要用户审批。' +
      '会话级"始终允许"只对简单单命令可用（按 可执行文件+子命令 前缀匹配）；含 ; && || 管道、重定向、$()/反引号、环境变量前缀、sh -c 等组合/展开形态只能逐次批准，不会因一次授权而复用。' +
      '默认沙箱写边界受限：命令需写工作区外（改全局 git 配置、装系统级依赖等）时置 sandbox_permissions="require_escalated" 且必须附非空 justification 说明理由，将触发独立的橙色提权审批（展示命令中出现的绝对路径目标），Runtime 不会因报错自动静默重跑提权版；工作区内普通写操作无需提权。' +
      '沙箱默认禁网：命令需要联网（npm install / git push / curl 等）时必须将 requires_network 置 true 并等待用户批准；未声明的联网尝试在 macOS/Linux 沙箱内会被 OS 直接拒绝（Windows 为流程闸门）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: {
          type: 'string',
          description: '工作区相对的工作目录，缺省为工作区根',
        },
        requires_network: {
          type: 'boolean',
          description:
            '命令是否需要联网（npm install / git push / curl 等）。需要联网时必须置 true，将触发独立的网络审批；缺省 false。',
        },
        sandbox_permissions: {
          type: 'string',
          enum: ['use_default', 'require_escalated'],
          description:
            '缺省 use_default（当前档位沙箱）。仅当命令确需访问工作区外路径时置 require_escalated，并附非空 justification；这将触发工作区外提权审批，不得用于规避工作区内正常写边界。',
        },
        justification: {
          type: 'string',
          description:
            'require_escalated 时必填的提权理由（一句话说明为什么需要工作区外访问），进入审批卡展示。',
        },
        prefix_rule: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：提议一个可复用命令前缀（如 ["git","status"]）供审批卡作为"本会话允许"候选。Runtime 会校验它与实际命令逐 token 匹配且命令为简单单命令；校验失败仅退化为一次性授权，绝不据此自行扩权。',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: '超时毫秒数，默认 30000，最大 120000',
        },
      },
      required: ['command'],
    },
    execute: ({ args, signal, grant }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        command: requireString(args, 'command'),
        grant: grant ?? '',
      }
      const cwd = optionalString(args, 'cwd')
      if (cwd !== undefined) params.cwd = cwd
      const timeoutMs = optionalNumber(args, 'timeoutMs')
      if (timeoutMs !== undefined) params.timeoutMs = Math.trunc(timeoutMs)
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        (args as Record<string, unknown>).requires_network === true
      ) {
        params.allowNetwork = true
      }
      return callSystem(system, 'shell.execute', params, signal).then(
        (result) => outputStore.capture(result),
      )
    },
  }
}
