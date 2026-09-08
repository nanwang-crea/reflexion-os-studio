import type { ProviderCapability } from '@reflexion-os-studio/contracts'
import { CommandError } from './agent/errors.js'
import { streamChatCompletion } from './provider.js'
import { deleteSecret, loadSecret, saveSecret } from './secrets.js'
import { requireString, type CommandHandler } from './command-utils.js'

/** Provider Profile 命令：配置（含密钥落盘）、删除、列表。 */
export const providerCommandHandlers: Record<string, CommandHandler> = {
  'provider.list': (_p, { store }) => ({
    profiles: store.providers.list(),
  }),
  'provider.configure': (p, { store }) => {
    let secretRef =
      typeof p.secretRef === 'string' && p.secretRef !== ''
        ? p.secretRef
        : undefined
    if (typeof p.secret === 'string' && p.secret !== '') {
      // 明文 Key 只在此处出现一次，落盘后从内存语义上丢弃。
      secretRef = saveSecret(p.secret)
    }
    if (!secretRef) {
      throw new CommandError(
        'invalid_request',
        'provider.configure 需要 secret 或 secretRef',
      )
    }
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== '')
    if (models.length === 0) {
      throw new CommandError(
        'invalid_request',
        'provider.configure 至少需要一个模型',
      )
    }
    const id = typeof p.id === 'string' && p.id !== '' ? p.id : undefined
    const existing = id ? store.providers.get(id) : null
    const profile = store.providers.upsert({
      id,
      name: requireString(p, 'name'),
      baseUrl: requireString(p, 'baseUrl'),
      models: [...new Set(models)],
      // capabilities 省略时由 store 保留原值（新建缺省 ['chat']）。
      capabilities: Array.isArray(p.capabilities)
        ? (p.capabilities as ProviderCapability[])
        : undefined,
      secretRef,
      enabled: p.enabled === undefined ? true : p.enabled === true,
      // Keep the three-state semantics: omitted=preserve, null=clear, value=set.
      temperature: p.temperature as number | null | undefined,
      maxTokens: p.maxTokens as number | null | undefined,
      contextWindow: p.contextWindow as number | null | undefined,
      contextBudget: p.contextBudget as number | null | undefined,
    })
    // 换 Key 后清理被替换的旧密钥，secrets.json 不留孤儿条目。
    if (existing && existing.secretRef !== profile.secretRef) {
      deleteSecret(existing.secretRef)
    }
    return { profile }
  },
  'provider.delete': (p, { store }) => {
    const id = requireString(p, 'id')
    const profile = store.providers.get(id)
    if (!profile) return { removed: false }
    const removed = store.providers.delete(id)
    // 配置行已删则其密钥引用也不应残留；secret 文件里其余条目不受影响。
    deleteSecret(profile.secretRef)
    return { removed }
  },
}

/**
 * 供应商连接测试：发起一次 1 token 的补全，把 Provider 的
 * 鉴权/网络/模型错误原样返回给 UI（不落盘、不写库）。
 * 涉及网络等待，由 index.ts 异步调度、完成后单独回包。
 */
export async function testProviderConnection(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseUrl = requireString(params, 'baseUrl')
  const model = requireString(params, 'model')
  const secret =
    typeof params.secret === 'string' && params.secret !== ''
      ? params.secret
      : undefined
  const secretRef =
    typeof params.secretRef === 'string' && params.secretRef !== ''
      ? params.secretRef
      : undefined
  const apiKey = secret ?? (secretRef ? loadSecret(secretRef) : undefined)
  if (!apiKey) {
    throw new CommandError(
      'invalid_request',
      '缺少 API Key：请填写或先保存配置',
    )
  }
  const startedAt = Date.now()
  try {
    await streamChatCompletion(
      {
        baseUrl,
        apiKey,
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        timeoutMs: 15_000,
        // 连接测试要快速给出结论,不做限流/网络重试。
        maxRetries: 0,
        signal: new AbortController().signal,
      },
      () => {},
    )
    return { ok: true, latencyMs: Date.now() - startedAt, model, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model,
      error: message,
    }
  }
}
