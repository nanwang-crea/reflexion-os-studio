import { z } from 'zod'
import policy from './no-read-policy.json' with { type: 'json' }

/** Also embedded by Rust: policy changes must not drift between enforcement layers. */
export const NoReadPolicySchema = z.object({
  names: z.array(z.string()),
  prefixes: z.array(z.string()),
  suffixes: z.array(z.string()),
  homePaths: z.array(z.string()),
  unixPaths: z.array(z.string()),
})
export const NO_READ_POLICY = NoReadPolicySchema.parse(policy)
