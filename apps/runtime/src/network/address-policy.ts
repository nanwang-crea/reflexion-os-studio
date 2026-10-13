import { BlockList, isIP } from 'node:net'

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const specialV6 = new BlockList()
specialV6.addSubnet('2001::', 23, 'ipv6')
specialV6.addSubnet('2001:db8::', 32, 'ipv6')
specialV6.addSubnet('2002::', 16, 'ipv6')
specialV6.addSubnet('3fff::', 20, 'ipv6')

/** Shared browser/web egress boundary; mapped/transition/special IPv6 fails closed. */
export function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 6)
    return (
      globalV6.check(normalized, 'ipv6') && !specialV6.check(normalized, 'ipv6')
    )
  if (isIP(normalized) !== 4) return false
  const parts = normalized.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false
  const [a, b] = parts
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  )
}
