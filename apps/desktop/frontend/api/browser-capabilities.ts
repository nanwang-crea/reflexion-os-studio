import type { BrowserCapabilities } from '@reflexion-os-studio/runtime-client'
import { browserSurface } from './browser'

export function getBrowserCapabilities(): Promise<BrowserCapabilities> {
  return browserSurface.capabilities()
}
