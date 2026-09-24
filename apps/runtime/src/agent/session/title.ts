import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import { streamChatCompletion } from '../../provider.js'
import { TITLE_SYSTEM_PROMPT } from '../prompts/index.js'

const TITLE_MAX_LENGTH = 24
const TITLE_LLM_MAX_LENGTH = 30

/** 用首条用户消息派生会话标题；无有效内容时返回 null（保留默认标题）。 */
export function deriveSessionTitle(content: string): string | null {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return null
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, TITLE_MAX_LENGTH)}…`
}

/** 根据用户的第一条消息，使用 LLM 生成简短的中文会话标题。
 * 失败/超时/空输出时返回 null，不影响对话进行。
 * 调用者应确保 session.title 仍为 DEFAULT_SESSION_TITLE。
 */
export async function generateSessionTitle(
  content: string,
  provider: {
    profile: ProviderProfile
    apiKey: string
    model: string
    signal: AbortSignal
  },
): Promise<string | null> {
  // 输入截断到约 500 字，避免标题请求比对话还贵
  const truncated = content.trim().replace(/\s+/g, ' ').slice(0, 500)
  if (truncated === '') return null

  const result = await streamChatCompletion(
    {
      baseUrl: provider.profile.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: truncated },
      ],
      signal: provider.signal,
      timeoutMs: 15_000,
      maxRetries: 0,
      temperature: 0,
      maxTokens: 64,
    },
    () => {},
  )
  const cleaned = result.content
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?；;，,：:、.]+$/u, '')
  if (cleaned === '') return null
  if (cleaned.length > TITLE_LLM_MAX_LENGTH) {
    return cleaned.slice(0, TITLE_LLM_MAX_LENGTH)
  }
  return cleaned
}
