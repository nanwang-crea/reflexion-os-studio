import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/** 列出某会话的所有委派记录（父子 Run 关联查询，实时刷新用）。 */
export async function listDelegations(
  sessionId: string,
): Promise<Delegation[]> {
  const result = await request<{ delegations: Delegation[] }>(
    'delegation.list',
    { sessionId },
  )
  return result.delegations
}
