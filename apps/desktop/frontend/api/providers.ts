import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

export function listProviders(): Promise<{
  profiles: ProviderProfile[]
}> {
  return requestList<{ profiles: ProviderProfile[] }>('provider.list')
}

export interface ConfigureProviderPayload {
  id?: string
  name: string
  baseUrl: string
  models: string[]
  /** 新明文 Key 只在此处出现一次；留空表示沿用已保存密钥。 */
  secret?: string
  secretRef?: string
  temperature?: number | null
  maxTokens?: number | null
  /** 模型上下文窗口（token 数）；Runtime 据此动态计算上下文预算。 */
  contextWindow?: number | null
  /** 上下文预算上限（token 数）；缺省 64k。 */
  contextBudget?: number | null
  enabled?: boolean
}

export function configureProvider(
  payload: ConfigureProviderPayload,
): Promise<{ profile: ProviderProfile }> {
  return request<{ profile: ProviderProfile }>('provider.configure', payload)
}

export function deleteProvider(id: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('provider.delete', { id })
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  model: string
  error: string | null
}

export function testProvider(input: {
  baseUrl: string
  model: string
  secret?: string
  secretRef?: string
}): Promise<ProviderTestResult> {
  return request<ProviderTestResult>('provider.test', input)
}
