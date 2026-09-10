// 统一剪贴板写入：Tauri 插件（Rust 侧）→ Clipboard API → execCommand 三级降级。
// 背景：macOS WKWebView 中 navigator.clipboard.writeText 即使在用户手势内、
// 文档聚焦时也可能抛 NotAllowedError（[copy-diag] 日志已证实），故 Rust 通道为主。
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

/** 仅在 Tauri WebView 内启用插件通道；纯 Web 环境跳过以免产生无谓报错。 */
const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function viaTauriPlugin(text: string): Promise<void> {
  if (!hasTauri) throw new Error('not in tauri webview')
  await writeText(text)
}

async function viaClipboardApi(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('navigator.clipboard.writeText unavailable')
  }
  await navigator.clipboard.writeText(text)
}

/** 最后兜底：隐藏 textarea + execCommand，用户手势内几乎必成。 */
function viaExecCommand(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('execCommand("copy") returned false')
}

/**
 * 写文本到系统剪贴板，按可靠性依次降级，全部失败返回 false。
 * 每级失败都会留下 console.error，不再静默吞错。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await viaTauriPlugin(text)
    return true
  } catch (error) {
    console.error('[clipboard] tauri plugin channel failed:', error)
  }
  try {
    await viaClipboardApi(text)
    return true
  } catch (error) {
    console.error('[clipboard] navigator.clipboard channel failed:', error)
  }
  try {
    viaExecCommand(text)
    return true
  } catch (error) {
    console.error('[clipboard] execCommand fallback failed:', error)
    return false
  }
}
