import { browserSurface } from './browser'

/** Validated HTTP / HTTPS URLs only; the Rust Host independently validates. */
export function openExternalUrl(url: string): Promise<void> {
  return browserSurface.openExternal(url)
}
