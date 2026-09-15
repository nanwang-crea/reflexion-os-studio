import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import {
  checkAbsoluteUrl,
  contractRangeHint,
  formatFieldFeedbacks,
  validateCommandParams,
} from '@reflexion-os-studio/runtime-client'
import type { ConfigureProviderPayload } from '../../api/providers'

/**
 * 供应商表单的纯逻辑：草稿类型、契约派生的 range hint、以及"保存/切换"前的
 * 本地预检（URL + 契约 zod 校验 + 脏 secretRef 兜底）。
 * 与 ProviderEditor 组件分离，保证组件文件只做视图与状态编排。
 */

export interface Draft {
  /** null 表示尚未保存的新供应商。 */
  id: string | null
  name: string
  baseUrl: string
  models: string[]
  /** 新输入的明文 Key；为空表示沿用已保存的密钥。 */
  secret: string
  secretRef: string | null
  enabled: boolean
  /** 采样参数；空串表示未配置（服务端默认）。 */
  temperature: string
  maxTokens: string
  /** 模型上下文窗口（token 数）；空串表示未知（Runtime 用保守默认）。 */
  contextWindow: string
  /** 上下文预算上限（token 数）；空串表示默认 64k。 */
  contextBudget: string
}

export const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  baseUrl: '',
  models: [''],
  secret: '',
  secretRef: null,
  enabled: true,
  temperature: '',
  maxTokens: '',
  contextWindow: '',
  contextBudget: '',
}

export function draftFromProfile(profile: ProviderProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    models: [...profile.models],
    secret: '',
    secretRef: profile.secretRef,
    enabled: profile.enabled,
    temperature: profile.temperature == null ? '' : String(profile.temperature),
    maxTokens: profile.maxTokens == null ? '' : String(profile.maxTokens),
    contextWindow:
      profile.contextWindow == null ? '' : String(profile.contextWindow),
    contextBudget:
      profile.contextBudget == null ? '' : String(profile.contextBudget),
  }
}

/**
 * 数值字段的合法范围直接派生自 provider.configure 的 zod 契约，
 * 避免"前端 max=2 / 后端 max(2)"两处漂移。取不到时（契约未标注）
 * hint 为 undefined，UI 退回静态文案。
 */
const RANGE_HINTS: Record<string, string | undefined> = {
  temperature: contractRangeHint('provider.configure', 'temperature'),
  maxTokens: contractRangeHint('provider.configure', 'maxTokens'),
  contextWindow: contractRangeHint('provider.configure', 'contextWindow'),
  contextBudget: contractRangeHint('provider.configure', 'contextBudget'),
}

export type SamplingKey = keyof typeof RANGE_HINTS

export function samplingHint(key: SamplingKey, fallback: string): string {
  const range = RANGE_HINTS[key]
  return range ? `${range}；${fallback}` : fallback
}

/** 表单数字解析：空串/非法输入返回 null（= 清空回未配置）；integer 时取整。 */
export function parseNumber(text: string, integer: boolean): number | null {
  if (text.trim() === '') return null
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return null
  return integer ? Math.trunc(value) : value
}

/** 空串与 null 归一化：契约要求 `secretRef.min(1)`，脏数据里的 `''` 必须剔除。 */
export function normalizeSecretRef(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 预检结果：通过则携带 payload，失败则携带可直接展示的中文错误。 */
export type Preflight<T> =
  { ok: true; payload: T } | { ok: false; error: string }

/**
 * 保存 provider.configure 前的本地预检：URL、必填项、脏 secretRef、
 * 以及完整 zod 契约。避免把"必然被后端拒"的请求发出去换来一句
 * 干巴巴的 Invalid params。
 */
export function preflightProviderSave(
  draft: Draft,
): Preflight<ConfigureProviderPayload> {
  const models = [
    ...new Set(
      draft.models.map((model) => model.trim()).filter((model) => model),
    ),
  ]
  if (!draft.name.trim() || !draft.baseUrl.trim() || models.length === 0) {
    return { ok: false, error: '名称、Base URL 和至少一个模型为必填项' }
  }
  const baseUrl = draft.baseUrl.trim()
  const urlError = checkAbsoluteUrl(baseUrl, 'Base URL')
  if (urlError) return { ok: false, error: urlError }
  const hasNewSecret = draft.secret.trim() !== ''
  if (!draft.id && !hasNewSecret) {
    return { ok: false, error: '新供应商需要填写 API Key' }
  }
  const secretRef = hasNewSecret
    ? undefined
    : normalizeSecretRef(draft.secretRef)
  const payload: ConfigureProviderPayload = {
    id: draft.id ?? undefined,
    name: draft.name.trim(),
    baseUrl,
    models,
    secret: hasNewSecret ? draft.secret.trim() : undefined,
    secretRef,
    enabled: draft.enabled,
    temperature: parseNumber(draft.temperature, false),
    maxTokens: parseNumber(draft.maxTokens, true),
    contextWindow: parseNumber(draft.contextWindow, true),
    contextBudget: parseNumber(draft.contextBudget, true),
  }
  if (draft.id && !hasNewSecret && !secretRef) {
    return {
      ok: false,
      error: '该供应商没有已保存的密钥，请重新输入 API Key 后再保存',
    }
  }
  const feedbacks = validateCommandParams('provider.configure', {
    requestId: 'preflight',
    ...payload,
  })
  if (feedbacks) return { ok: false, error: formatFieldFeedbacks(feedbacks) }
  return { ok: true, payload }
}

/**
 * 启用/切换路径的预检：库里可能存在旧脏数据（models 含空串、secretRef 缺失）。
 * 透传前清洗 + 预检，避免"最无害的动作"也吐 -32602。
 */
export function preflightProviderToggle(
  profile: ProviderProfile,
  nextEnabled: boolean,
): Preflight<ConfigureProviderPayload> {
  const cleanedModels = profile.models
    .map((model) => model.trim())
    .filter((model) => model)
  const secretRef = normalizeSecretRef(profile.secretRef)
  if (cleanedModels.length === 0) {
    return {
      ok: false,
      error: '该供应商的模型列表为空，请先在表单中至少填一个模型再保存',
    }
  }
  if (!secretRef) {
    return {
      ok: false,
      error: '该供应商没有已保存的密钥，请重新输入 API Key 并保存后再切换',
    }
  }
  const payload: ConfigureProviderPayload = {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    models: cleanedModels,
    secretRef,
    enabled: nextEnabled,
  }
  const feedbacks = validateCommandParams('provider.configure', {
    requestId: 'preflight',
    ...payload,
  })
  if (feedbacks) return { ok: false, error: formatFieldFeedbacks(feedbacks) }
  return { ok: true, payload }
}

/** 连接测试预检（provider.test 契约）。 */
export function preflightProviderTest(draft: Draft): Preflight<{
  baseUrl: string
  model: string
  secret?: string
  secretRef?: string
}> {
  const model = draft.models.map((item) => item.trim()).find(Boolean)
  if (!draft.baseUrl.trim() || !model) {
    return { ok: false, error: '先填写 Base URL 和至少一个模型' }
  }
  const urlError = checkAbsoluteUrl(draft.baseUrl.trim(), 'Base URL')
  if (urlError) return { ok: false, error: urlError }
  const hasNewSecret = draft.secret.trim() !== ''
  if (!draft.id && !hasNewSecret)
    return { ok: false, error: '请先填写 API Key' }
  const payload = {
    baseUrl: draft.baseUrl.trim(),
    model,
    secret: hasNewSecret ? draft.secret.trim() : undefined,
    secretRef: hasNewSecret ? undefined : normalizeSecretRef(draft.secretRef),
  }
  const feedbacks = validateCommandParams('provider.test', {
    requestId: 'preflight',
    ...payload,
  })
  if (feedbacks) return { ok: false, error: formatFieldFeedbacks(feedbacks) }
  return { ok: true, payload }
}
