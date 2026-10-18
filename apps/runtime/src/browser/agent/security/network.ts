import { isSafeAgentBrowserUrl } from '@reflexion-os-studio/contracts'

export function allowedRequest(
  origin: string,
  raw: string,
  method: string,
): boolean {
  return (
    ['GET', 'HEAD'].includes(method) &&
    isSafeAgentBrowserUrl(raw) &&
    new URL(raw).origin === origin
  )
}
