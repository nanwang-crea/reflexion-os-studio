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
    return parseResourceUri(href)
  } catch {
    return null
  }
}

const LINK_RE_GLOBAL = /\[([^\]]*)\]\(([^)\s]*)\)/g

/** 从文本提取全部资源链接（Artifact 聚合卡与内联渲染共用）。 */
export function extractResourceLinks(text: string): ResourceLink[] {
  const links: ResourceLink[] = []
  for (const match of text.matchAll(LINK_RE_GLOBAL)) {
    const parsed = parseResourceLink(match[2])
    if (parsed !== null) links.push(parsed)
  }
  return links
}

/** workspace:// 与 asset:// 引用显示名：无标题文本时用最短有意义的片段。 */
export function displayNameOf(link: ResourceLink): string {
  if (link.kind === 'workspaceFile') return link.path
  if (link.kind === 'asset') return link.assetId.slice(0, 8)
  return link.uri
}
