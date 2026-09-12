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
      '在工作区内执行 shell 命令（POSIX sh / Windows cmd），返回退出码与输出。truncated=true 表示 stdout 或 stderr 超过输出上限，需改用更窄的命令范围或分页/重定向到工作区文件后用 file.read 分段读取。cwd 需在工作区内。需要用户审批。沙箱默认禁网：命令需要联网（npm install / git push / curl 等）时必须将 requires_network 置 true 并等待用户批准，未声明时未来 OS 沙箱内必失败。',
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
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        (args as Record<string, unknown>).requires_network === true
      ) {
        params.allowNetwork = true
      }
      return callSystem(system, 'shell.execute', params, signal)
    },
  }
}
