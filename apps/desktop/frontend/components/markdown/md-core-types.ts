/** Markdown 内核共享类型与纯逻辑（无渲染依赖）。 */
import {
  parseResourceUri,
  type ResourceLink,
} from '@reflexion-os-studio/runtime-client'

/** 内核 markdown 组件的共享 props（聊天消息与文件预览共用）。 */
export interface MarkdownCoreProps {
  /** 原始 markdown 源文本。 */
  text: string
  /** 聊天流式输出时在最后一个块尾追加光标（文件预览不适用）。 */
  caret?: boolean
  /** 去掉外层 .md 容器：预览按块拼装时由宿主统一提供容器。 */
  bare?: boolean
  /** 资源引用（workspace:// asset:// https://）点击回调；宿主按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
}

/** 解析消息内资源引用协议；非资源协议（http 等）返回 null 保持普通链接。 */
export function parseResourceLink(href: string): ResourceLink | null {
  try {
    // Older messages encoded a line fragment as part of the workspace filename.
    const normalized =
      href.startsWith('workspace://') && !href.includes('#')
        ? href.replace(/%23(L[1-9]\d*(?:-L?[1-9]\d*)?)$/i, '#$1')
        : href
    return parseResourceUri(normalized)
  } catch {
    return null
  }
}

/** workspace:// 与 asset:// 引用显示名：无标题文本时用最短有意义的片段。 */
export function displayNameOf(link: ResourceLink): string {
  if (link.kind === 'workspaceFile') return link.path
  if (link.kind === 'asset') return link.assetId.slice(0, 8)
  return link.uri
}
