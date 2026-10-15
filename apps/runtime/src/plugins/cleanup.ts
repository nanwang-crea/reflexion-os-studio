import { rmSync } from 'node:fs'

/** Cleanup must not replace an operation's result; callers can retry retained paths. */
export function cleanupTemporaryBestEffort(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    process.stderr.write(
      '[runtime] Skill temporary files retained for later cleanup\n',
    )
    return false
  }
}
