import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { loadSecret } from '../../secrets.js'
import { effectiveProviderModel, knownCapabilities } from './capabilities.js'
import { ModelMetadataPageSchema, parseModelMetadata } from './metadata.js'

const MAX_BYTES = 4 * 1024 * 1024

export function listEffectiveModels(store: Store, profile: ProviderProfile) {
  const stored = store.providerModels.list(profile.id)
  const models = [
    ...new Set([...profile.models, ...stored.map((item) => item.model)]),
  ]
  return models.map((model) =>
    effectiveProviderModel(
      profile,
      model,
      stored.find((item) => item.model === model) ?? null,
    ),
  )
}

/** Metadata only; credentials go solely to the configured origin, never redirects. */
export async function refreshModelCapabilities(
  store: Store,
  profile: ProviderProfile,
): Promise<string | undefined> {
  const apiKey = loadSecret(profile.secretRef)
  if (!apiKey) return '缺少供应商密钥，已保留缓存与已知模型信息'
  const snapshot = JSON.stringify(profile)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const url = new URL(
      `${profile.baseUrl.replace(/\/$/, '')}${profile.apiFormat === 'anthropic' ? '/v1/models' : '/models'}`,
    )
    const pending = new Map<
      string,
      NonNullable<ReturnType<typeof parseModelMetadata>>['capabilities']
    >()
    for (let page = 0; page < 20; page++) {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          ...Object.fromEntries(
            profile.headers.map(({ name, value }) => [name, value]),
          ),
          ...(profile.apiFormat === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${apiKey}` }),
        },
      })
      if (!response.ok) throw new Error('metadata request failed')
      if (!response.body) throw new Error('missing metadata')
      const reader = response.body.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) throw new Error('metadata too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      const data = ModelMetadataPageSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      )
      for (const value of data.data) {
        const item = parseModelMetadata(value, new Date().toISOString())
        if (!item || !profile.models.includes(item.model)) continue
        if (JSON.stringify(item.capabilities).includes(apiKey)) continue
        const known = knownCapabilities(profile, item.model)
        pending.set(item.model, {
          ...item.capabilities,
          options: item.capabilities.options ?? known.options,
        })
      }
      if (!data.has_more) {
        // Do not apply results to a provider edited/deleted while the request was in flight.
        if (JSON.stringify(store.providers.get(profile.id)) !== snapshot)
          return '供应商配置已更改，请重新刷新'
        for (const [model, capabilities] of pending)
          store.providerModels.saveDetection(profile.id, model, capabilities)
        return pending.size
          ? undefined
          : '接口未提供可识别的思考能力，已使用缓存或已知模型信息'
      }
      if (!data.last_id || url.searchParams.get('after_id') === data.last_id)
        throw new Error('invalid pagination')
      url.searchParams.set('after_id', data.last_id)
    }
    throw new Error('too many pages')
  } catch {
    // Never surface response bodies, URLs or raw fetch errors containing credentials.
    return '能力获取失败或接口不支持，已保留缓存；可手动覆盖'
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
}
