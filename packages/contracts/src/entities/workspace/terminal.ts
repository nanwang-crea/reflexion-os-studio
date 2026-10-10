import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'

// ---------------- 集成终端（W2） ----------------

/**
 * 终端生命周期状态机（spec §5）。原声明于 events.ts，移入此处作为 Terminal
 * 实体字段复用；entities 不依赖 events（events 反向 import 本文件），避免环。
 */
export const TerminalStatusSchema = z.enum([
  'starting',
  'running',
  'closing',
  'closed',
  'exited',
  'disconnected',
  'failed',
])
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>

/**
 * 用户终端实体：项目级、多会话。initialCwd 是启动目录（workspace 路径），
 * 不是 shell 当前目录（首版无法可靠观测）。generation 记录事件来源的
 * sidecar 进程标识（Rust 侧实现为进程内常数）：用于同代内迟到帧过滤与
 * 旧代际事件甄别；**跨重启识别由 TS 侧进程监管完成**（sidecar 重拉即
 * markAllDisconnected，不承诺此数值随重启递增），终审 #7 口径收敛。
 */
export const TerminalSchema = z.object({
  terminalId: z.string().min(1),
  projectId: z.string().min(1),
  /** 初始目录（workspace 路径）；不是 shell 当前目录（首版无法可靠观测）。 */
  initialCwd: z.string().min(1),
  /** 启动 shell 的 argv（路径+独立参数，spec §6）。 */
  shellArgv: z.array(z.string().min(1)),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  status: TerminalStatusSchema,
  /** 退出信息：仅 exited/closed 后有值。 */
  exitCode: z.number().int().nullable().optional(),
  /** sidecar 进程代际标识（进程内常数；跨重启识别见上方实体注释）。 */
  generation: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
})
export type Terminal = z.infer<typeof TerminalSchema>
