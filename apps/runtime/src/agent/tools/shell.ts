import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, requireString } from './shared.js'

export function createShellExecuteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'shell.execute',
    description:
      '在工作区内执行 shell 命令（POSIX sh / Windows cmd），返回退出码与输出。cwd 需在工作区内。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: {
          type: 'string',
          description: '工作区相对的工作目录，缺省为工作区根',
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
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        typeof (args as Record<string, unknown>).cwd === 'string'
      ) {
        params.cwd = (args as Record<string, unknown>).cwd
      }
      return callSystem(system, 'shell.execute', params, signal)
    },
  }
}
