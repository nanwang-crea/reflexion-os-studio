import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isSafeAgentBrowserUrl } from '@reflexion-os-studio/contracts'
import { isPublicIp } from '../../../network/address-policy.js'
export { isPublicIp as publicIp } from '../../../network/address-policy.js'

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
export async function publicAddress(host: string): Promise<string> {
  const name = host.replace(/^\[|\]$/g, '')
  const addresses = isIP(name)
    ? [{ address: name }]
    : await lookup(name, { all: true, verbatim: true })
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicIp(address))
  )
    throw new Error('browser_network_denied')
  return addresses[0].address
}
