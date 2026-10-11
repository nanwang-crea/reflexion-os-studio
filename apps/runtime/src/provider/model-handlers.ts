import {
  CommandSchemaRegistry,
  type ProviderProfile,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'
import { requireString, type CommandHandler } from '../command-utils.js'
import type { Store } from '../store/index.js'

function requireProvider(store: Store, providerId: string): ProviderProfile {
  const profile = store.providers.get(providerId)
  if (!profile) {
    throw new CommandError('invalid_request', 'Provider 不存在')
  }
  return profile
}

export const providerModelCommandHandlers: Record<string, CommandHandler> = {
  'provider.model.list': (p, { store }) => {
    const providerId = requireString(p, 'providerId')
    requireProvider(store, providerId)
    return { models: store.providerModels.list(providerId) }
  },
  'provider.model.configure': (p, { store }) => {
    const input =
      CommandSchemaRegistry['provider.model.configure'].params.parse(p)
    const profile = requireProvider(store, input.providerId)
    if (!profile.models.includes(input.model)) {
      throw new CommandError('invalid_request', '模型不在 Provider 模型列表中')
    }
    if (input.reasoningEffortSupported && profile.apiFormat === 'anthropic') {
      throw new CommandError(
        'invalid_request',
        '当前 Anthropic 适配器不支持思考强度参数',
      )
    }
    return { model: store.providerModels.upsert(input) }
  },
  'provider.model.delete': (p, { store }) => {
    const providerId = requireString(p, 'providerId')
    requireProvider(store, providerId)
    return {
      removed: store.providerModels.delete(
        providerId,
        requireString(p, 'model'),
      ),
    }
  },
}
