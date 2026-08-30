import { ProviderError } from './provider.js'
import { loadSecret } from './secrets.js'
import type { Store } from './store/index.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface EmbedOptions {
  baseUrl: string
  apiKey: string
  model: string
  inputs: string[]
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * OpenAI-compatible /embeddings 客户端（A2 Memory 召回用）。
 * 返回向量按返回顺序排列；不同 provider 的向量维度/空间互不兼容，
 * 调用方必须把模型名一并落库（memory.embedding_model），余弦只在同模型间计算。
 */
export async function embedTexts(options: EmbedOptions): Promise<number[][]> {
  if (options.inputs.length === 0) return []
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout

  let response: Response
  try {
    response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        input: options.inputs,
      }),
      signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ProviderError(
      'network',
      `embedding request failed: ${String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ProviderError(
      'provider',
      `embedding responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }

  let parsed: {
    data?: { index?: number; embedding?: unknown }[]
  }
  try {
    parsed = (await response.json()) as typeof parsed
  } catch {
    throw new ProviderError('provider', 'embedding response is not JSON')
  }
  const rows = parsed.data ?? []
  const vectors = rows
    .map((row) => (Array.isArray(row.embedding) ? row.embedding : null))
    .map((embedding) =>
      embedding === null
        ? null
        : embedding.map((value) => (typeof value === 'number' ? value : 0)),
    )
  if (vectors.length !== options.inputs.length) {
    throw new ProviderError(
      'provider',
      `embedding count mismatch: expected ${options.inputs.length}, got ${vectors.length}`,
    )
  }
  return vectors.map((vector) => vector ?? [])
}

export interface EmbeddingProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 召回侧的 embedding Provider 解析：第一个启用且声明 embedding 能力的供应商。
 * 未配置时返回 null —— 召回自动降级为 FTS + recency，功能不依赖向量。
 */
export function resolveEmbeddingProvider(
  store: Store,
): EmbeddingProviderConfig | null {
  const profile = store.providers
    .list()
    .find((item) => item.enabled && item.capabilities.includes('embedding'))
  if (!profile) return null
  const apiKey = loadSecret(profile.secretRef)
  if (!apiKey || profile.models.length === 0) return null
  return { baseUrl: profile.baseUrl, apiKey, model: profile.models[0] }
}
