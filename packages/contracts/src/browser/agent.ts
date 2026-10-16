import { z } from 'zod'

const sensitive =
  /(?:password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key|id_token|\.env(?:[./?#]|$)|\.(?:pem|key)(?:[/?#]|$)|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|keychain|cookie|login|signin|sign-in|oauth|\/auth(?:\/|$))/i

export function isSafeAgentBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    let decoded = url.pathname + url.search + url.hash
    for (let depth = 0; depth < 4 && /%[a-f\d]{2}/i.test(decoded); ++depth)
      decoded = decodeURIComponent(decoded)
    if (/%[a-f\d]{2}/i.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded))
      return false
    return (
      value.length <= 2048 &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !sensitive.test(decoded) &&
      !/^(?:localhost|.*\.localhost|.*\.local)$/i.test(url.hostname)
    )
  } catch {
    return false
  }
}
export const AgentBrowserUrlSchema = z
  .string()
  .max(2048)
  .refine(isSafeAgentBrowserUrl)
export const AgentBrowserPageSchema = z.strictObject({
  tabId: z.uuid(),
  origin: z.url().refine((value) => new URL(value).origin === value),
  pageVersion: z.uuid(),
})
export type AgentBrowserPage = z.infer<typeof AgentBrowserPageSchema>
export const AgentBrowserNavigateSchema = z.strictObject({
  url: AgentBrowserUrlSchema,
  from: AgentBrowserPageSchema.optional(),
})
export const AgentBrowserDocumentSchema = z.strictObject({
  page: AgentBrowserPageSchema,
  sourceUrl: AgentBrowserUrlSchema,
  title: z.string().max(300),
  snapshot: z.string().max(50000).optional(),
  truncated: z.boolean(),
  injectionWarning: z.boolean(),
})
export type AgentBrowserDocument = z.infer<typeof AgentBrowserDocumentSchema>
export const AgentBrowserOperationSchema = z.enum([
  'browser.navigate',
  'browser.read',
  'browser.close',
  'browser.click',
  'browser.type',
  'browser.execute',
])

export const AgentBrowserNavigateJsonSchema = z.toJSONSchema(
  AgentBrowserNavigateSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
export const AgentBrowserPageJsonSchema = z.toJSONSchema(
  AgentBrowserPageSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
