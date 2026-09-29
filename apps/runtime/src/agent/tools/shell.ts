import { shellExecuteParameters } from '@reflexion-os-studio/contracts'
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
      '默认沙箱写边界受限：命令需写工作区外（包括命令隐含使用的配置、缓存和锁文件）时置 sandbox_permissions="require_escalated" 且必须附非空 justification 和 additional_write_roots 绝对路径数组，将触发独立的橙色提权审批（展示 Rust 预检后的实际可写范围），Runtime 不会因报错自动静默重跑提权版；工作区内普通写操作无需提权。additional_write_roots 不展开 ~ 或环境变量，支持空格与 Windows 路径；Linux/Windows 应申请现存目录。若需新建目录或工具使用相邻锁文件，应明确申请非敏感父目录，不能假定只批准文件就能写其兄弟文件。系统根与凭据目录及其祖先不能申请，审批不授予 sudo/管理员身份。' +
      '沙箱默认禁网：命令需要联网（npm install / git push / curl 等）时必须将 requires_network 置 true 并等待用户批准；未声明的联网尝试在 macOS/Linux 沙箱内会被 OS 直接拒绝（Windows 为流程闸门）。',
    parameters: shellExecuteParameters,
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
