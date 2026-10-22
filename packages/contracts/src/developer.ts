import { z } from 'zod'
import {
  RunSchema,
  RunStatusSchema,
  UsageSchema,
} from './entities/chat/runs.js'
import { ToolCallSchema, ToolCallStatusSchema } from './entities/tools/calls.js'
import { ProviderRequestAttemptSchema } from './providers/request-attempt.js'

const count = z.number().int().nonnegative()
export const ModelInvocationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().nullable(),
  messageId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string(),
  purpose: z.enum(['chat', 'title', 'summary']),
  status: z.enum([
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  usage: UsageSchema.nullable(),
  estimatedInputTokens: count.nullable(),
  contextWindow: count.nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
})
export type ModelInvocation = z.infer<typeof ModelInvocationSchema>

export const DeveloperFilterSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  projectId: z.string().min(1).nullable().optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})
export type DeveloperFilter = z.infer<typeof DeveloperFilterSchema>
export const DeveloperPageSchema = z.object({
  offset: count.default(0),
  limit: z.number().int().min(1).max(100).default(25),
})

export const UsageTotalsSchema = z.object({
  promptTokens: count,
  completionTokens: count,
  cachedPromptTokens: count,
  sources: count,
  reportedSources: count,
  cacheReportedSources: count,
  unreportedCalls: count,
  legacyRuns: count,
})
export type UsageTotals = z.infer<typeof UsageTotalsSchema>

export const DeveloperRunSchema = z.object({
  run: RunSchema,
  sessionTitle: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  providerName: z.string().nullable(),
  toolCalls: count,
  toolFailures: count,
  childRuns: count,
})
export type DeveloperRun = z.infer<typeof DeveloperRunSchema>

export const DeveloperToolSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  projectId: z.string().nullable(),
  model: z.string().nullable(),
  toolName: z.string(),
  status: ToolCallStatusSchema,
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
})
export type DeveloperTool = z.infer<typeof DeveloperToolSchema>

const GroupUsageSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  ...UsageTotalsSchema.shape,
})
export const DeveloperOverviewSchema = z.object({
  usage: UsageTotalsSchema,
  runs: count,
  failedRuns: count,
  tools: count,
  failedTools: count,
  days: z.array(GroupUsageSchema),
  models: z.array(GroupUsageSchema),
  toolGroups: z.array(
    z.object({ name: z.string(), calls: count, failures: count }),
  ),
})
export type DeveloperOverview = z.infer<typeof DeveloperOverviewSchema>

export const DeveloperRunDetailSchema = z.object({
  entry: DeveloperRunSchema,
  treeUsage: UsageTotalsSchema,
  treeRuns: count,
})
export type DeveloperRunDetail = z.infer<typeof DeveloperRunDetailSchema>

// Grants are never part of the developer projection.
export const DeveloperToolDetailSchema = ToolCallSchema.omit({
  approvalGrantId: true,
})
export type DeveloperToolDetail = z.infer<typeof DeveloperToolDetailSchema>
export const DeveloperAttemptSchema = ProviderRequestAttemptSchema.omit({
  content: true,
  reasoning: true,
})

export const DeveloperRunListParamsSchema = DeveloperFilterSchema.extend({
  ...DeveloperPageSchema.shape,
  status: RunStatusSchema.optional(),
  parentRunId: z.string().nullable().optional(),
})
export type DeveloperRunListParams = z.input<
  typeof DeveloperRunListParamsSchema
>
export const DeveloperToolListParamsSchema = DeveloperFilterSchema.extend({
  ...DeveloperPageSchema.shape,
  runId: z.string().optional(),
  toolName: z.string().optional(),
  status: ToolCallStatusSchema.optional(),
})
export type DeveloperToolListParams = z.input<
  typeof DeveloperToolListParamsSchema
>
export const DeveloperRunPageSchema = z.object({
  items: z.array(DeveloperRunSchema),
  total: count,
})
export const DeveloperToolPageSchema = z.object({
  items: z.array(DeveloperToolSchema),
  total: count,
})
export const DeveloperModelPageSchema = z.object({
  items: z.array(ModelInvocationSchema),
  total: count,
})
export const DeveloperAttemptPageSchema = z.object({
  items: z.array(DeveloperAttemptSchema),
  total: count,
})
export type DeveloperRunPage = z.infer<typeof DeveloperRunPageSchema>
export type DeveloperToolPage = z.infer<typeof DeveloperToolPageSchema>
export type DeveloperModelPage = z.infer<typeof DeveloperModelPageSchema>
export type DeveloperAttemptPage = z.infer<typeof DeveloperAttemptPageSchema>
