import { invoke } from '@tauri-apps/api/core'

/**
 * 外部 URL 安全打开：只允许 https，经 Tauri 白名单命令转系统默认浏览器，
 * 不在 WebView 内导航、不内嵌。非 https 由 Rust 侧拒绝并回错误。
 */
export function openExternalUrl(url: string): Promise<void> {
  return invoke('open_external', { url })
}
