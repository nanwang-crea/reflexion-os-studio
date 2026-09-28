import { z } from 'zod'
import { TerminalSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const terminalCommands = {
  'terminal.create': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
    }),
    result: z.object({ terminal: TerminalSchema }),
  },
  'terminal.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ terminals: z.array(TerminalSchema) }),
  },
  'terminal.attach': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 消费者代际：前端 xterm 宿主实例身份，重挂即新值。 */
      consumerId: z.string().min(1),
    }),
    result: z.object({
      terminal: TerminalSchema,
      replayedBytes: z.number().int().nonnegative(),
    }),
  },
  'terminal.write': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 前端每终端单调序号；服务端按序串行入队，重复不重写。 */
      inputSeq: z.number().int().nonnegative(),
      data: z.string().min(1),
    }),
    result: z.object({
      accepted: z.literal(true),
      inputSeq: z.number().int(),
    }),
  },
  'terminal.resize': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.ack': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
      /** 累计确认：已消费到的 outputSeq。 */
      throughOutputSeq: z.number().int().nonnegative(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.close': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      terminalId: z.string().min(1),
    }),
    result: z.object({ closed: z.literal(true) }),
  },
}
