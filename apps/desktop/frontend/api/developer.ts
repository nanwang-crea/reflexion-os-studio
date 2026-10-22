import type {
  DeveloperFilter,
  DeveloperOverview,
  DeveloperRunDetail,
  DeveloperToolDetail,
  DeveloperRunListParams,
  DeveloperToolListParams,
  DeveloperRunPage,
  DeveloperToolPage,
  DeveloperModelPage,
  DeveloperAttemptPage,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'
import { transport } from '../lib/transport'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'

export const getDeveloperOverview = (filter: DeveloperFilter) =>
  request<DeveloperOverview>('developer.overview', filter)
export const listDeveloperRuns = (input: DeveloperRunListParams) =>
  request<DeveloperRunPage>('developer.runs.list', input)
export const getDeveloperRun = async (runId: string) =>
  (
    await request<{ detail: DeveloperRunDetail | null }>('developer.run.get', {
      runId,
    })
  ).detail
export const listDeveloperTools = (input: DeveloperToolListParams) =>
  request<DeveloperToolPage>('developer.tools.list', input)
export const getDeveloperTool = async (toolCallId: string) =>
  (
    await request<{ detail: DeveloperToolDetail | null }>(
      'developer.tool.get',
      { toolCallId },
    )
  ).detail
export const listDeveloperModels = (
  input: DeveloperFilter & { runId?: string; offset?: number; limit?: number },
) => request<DeveloperModelPage>('developer.models.list', input)
export const listDeveloperAttempts = (messageId: string, offset: number) =>
  request<DeveloperAttemptPage>('developer.attempts.list', {
    messageId,
    offset,
    limit: 10,
  })

export function subscribeDeveloperChanges(
  handler: (event: RuntimeEvent) => void,
) {
  return transport.onEvent(handler)
}
