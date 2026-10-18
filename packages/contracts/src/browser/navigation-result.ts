import { z } from 'zod'
import { AgentBrowserUrlSchema } from './agent.js'

/** Presentation projection of a finalized browser.navigate ToolOutput. */
export const BrowserNavigationResultSchema = z.object({
  sessionId: z.string().min(1),
  rootSessionId: z.string().min(1),
  url: AgentBrowserUrlSchema,
  message: z.string().max(8000),
})
