import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import { optionalNumber, requireString } from './shared.js'

const FETCH_TIMEOUT_MS = 20_000
/** 响应体读取上限：超过部分直接截断，避免超大页面撑爆内存。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_LENGTH = 20_000
const MAX_MAX_LENGTH = 100_000

/**
 * 网络读取工具（纯 TS，不依赖 Rust）：抓取 URL 并转纯文本。
 * 只读、无本地副作用，与 get_current_time 同级，不需要 workspace 与审批。
 */
export function createWebFetchTool(): ToolDefinition {
  return {
    name: 'web.fetch',
    description:
      '抓取一个 http/https URL 并返回正文文本（HTML 自动去掉标签）。不能访问需要登录的页面，不要用它下载二进制文件。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http/https 地址' },
        maxLength: {
          type: 'number',
          description: '返回文本最大字符数，默认 20000',
        },
      },
      required: ['url'],
    },
    execute: async ({ args, signal }) => {
      try {
        const url = requireString(args, 'url')
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return failure('仅支持 http/https URL')
        }
        const maxLength =
          optionalNumber(args, 'maxLength') ?? DEFAULT_MAX_LENGTH
        const response = await fetch(parsed, {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(FETCH_TIMEOUT_MS),
          ]),
          redirect: 'follow',
          headers: { 'user-agent': 'ReflexionOS-Studio/0.3 (web-fetch)' },
        })
        if (!response.ok) {
          return failure(`HTTP ${response.status} ${response.statusText}`)
        }
        const buffer = await response.arrayBuffer()
        const clipped =
          buffer.byteLength > MAX_RESPONSE_BYTES
            ? buffer.slice(0, MAX_RESPONSE_BYTES)
            : buffer
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(clipped)
        const contentType = response.headers.get('content-type') ?? ''
        const text = contentType.includes('html') ? htmlToText(raw) : raw
        const bounded = Math.min(
          Math.max(Math.trunc(maxLength), 1),
          MAX_MAX_LENGTH,
        )
        const body = text.slice(0, bounded)
        const suffix =
          text.length > body.length
            ? `\n\n…（内容已截断，原文共 ${text.length} 字符）`
            : ''
        return { content: body + suffix, isError: false }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function failure(message: string): ToolResult {
  return {
    content: `抓取失败：${message}`,
    isError: true,
    code: 'web_fetch_error',
  }
}

/** 极简 HTML 转文本：去 script/style/注释，块级标签换行，还原常见实体。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(?:br|p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
