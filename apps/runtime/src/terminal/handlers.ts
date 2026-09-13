import { CommandError } from '../agent/errors.js'
import { requireString, type CommandHandler } from '../command-utils.js'

function requireInt(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CommandError(
      'invalid_request',
      `missing/invalid int param: ${key}`,
    )
  }
  return value
}

/**
 * 集成终端命令（W2）：全部经 TerminalService，用户本机 shell 不走 Agent 通道。
 * 参数已在 index.ts 过 zod 校验，此处只做取数与转发。
 */
export const terminalCommandHandlers: Record<string, CommandHandler> = {
  'terminal.create': (p, { terminal }) =>
    terminal.create(
      requireString(p, 'requestId'),
      requireString(p, 'projectId'),
      requireInt(p, 'rows'),
      requireInt(p, 'cols'),
    ),
  'terminal.list': (p, { terminal }) => ({
    terminals: terminal.list(requireString(p, 'projectId')),
  }),
  'terminal.attach': (p, { terminal }) =>
    terminal.attach(
      requireString(p, 'projectId'),
      requireString(p, 'terminalId'),
      requireString(p, 'consumerId'),
    ),
  'terminal.write': (p, { terminal }) =>
    terminal.write(
      requireString(p, 'projectId'),
      requireString(p, 'terminalId'),
      requireInt(p, 'inputSeq'),
      requireString(p, 'data'),
    ),
  'terminal.resize': async (p, { terminal }) => {
    await terminal.resize(
      requireString(p, 'projectId'),
      requireString(p, 'terminalId'),
      requireInt(p, 'rows'),
      requireInt(p, 'cols'),
    )
    return { ok: true as const }
  },
  'terminal.ack': (p, { terminal }) =>
    terminal.ack(
      requireString(p, 'projectId'),
      requireString(p, 'terminalId'),
      requireInt(p, 'throughOutputSeq'),
    ),
  'terminal.close': (p, { terminal }) =>
    terminal.close(
      requireString(p, 'projectId'),
      requireString(p, 'terminalId'),
    ),
}
