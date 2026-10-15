import { rmSync } from 'node:fs'

/** Cleanup must not replace an operation's result; startup recovery retries these paths. */
export function cleanupTemporaryBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    process.stderr.write(
      '[runtime] Skill temporary files retained for startup cleanup\n',
    )
  }
}
