import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import { ProviderError } from './provider-error.js'

type UserMessage = Extract<ModelMessage, { role: 'user' }>

export function userImageContent(
  message: UserMessage,
  format: 'openai-chat' | 'openai-responses' | 'anthropic',
): string | Record<string, unknown>[] {
  if (!message.images?.length) return message.content
  const images = message.images.map((image) => {
    if (!image.base64) throw new ProviderError('provider', '图片内容尚未加载')
    const url = `data:${image.mimeType};base64,${image.base64}`
    if (format === 'openai-chat')
      return { type: 'image_url', image_url: { url, detail: 'auto' } }
    if (format === 'openai-responses')
      return { type: 'input_image', image_url: url, detail: 'auto' }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.base64,
      },
    }
  })
  return [
    ...images,
    ...(message.content
      ? [
          {
            type: format === 'openai-responses' ? 'input_text' : 'text',
            text: message.content,
          },
        ]
      : []),
  ]
}
