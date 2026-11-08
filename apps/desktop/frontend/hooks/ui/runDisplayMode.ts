import { useSyncExternalStore } from 'react'

/**
 * 工作步骤显示模式（全局、持久化）：
 * - detailed：现有逐条过程时间线（思考、工具轨迹、过程正文）；
 * - standard：仅保留一行活动 + 一行思考摘要 + 最终回答，接近 DeepSeek Harness
 *   的紧凑视图。
 * 用模块级 store + useSyncExternalStore：任一 Run 的切换按钮都会同步所有 Run，
 * 并写入 localStorage 供下次启动沿用。
 */
export type RunDisplayMode = 'detailed' | 'standard'

const STORAGE_KEY = 'chat.runDisplayMode'
let cached: RunDisplayMode | null = null
const listeners = new Set<() => void>()

function readMode(): RunDisplayMode {
  if (cached !== null) return cached
  if (typeof window === 'undefined') return (cached = 'detailed')
  try {
    cached =
      window.localStorage.getItem(STORAGE_KEY) === 'standard'
        ? 'standard'
        : 'detailed'
  } catch {
    cached = 'detailed'
  }
  return cached
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setRunDisplayMode(mode: RunDisplayMode): void {
  if (cached === mode) return
  cached = mode
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 隐私模式/存储禁用时只在本次会话内生效。
  }
  for (const listener of listeners) listener()
}

export function toggleRunDisplayMode(): void {
  setRunDisplayMode(readMode() === 'standard' ? 'detailed' : 'standard')
}

export function useRunDisplayMode(): RunDisplayMode {
  return useSyncExternalStore(subscribe, readMode, readMode)
}
