import { mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Same-filesystem renames, with rollback until the final cancellation check. */
export async function publishBrowserInstallation(
  staging: string,
  destination: string,
  signal: AbortSignal,
  move = rename,
  validate: (directory: string) => boolean = () => true,
): Promise<void> {
  signal.throwIfAborted()
  const backupRoot = await mkdtemp(join(dirname(destination), 'backup-'))
  const backup = join(backupRoot, 'previous')
  let saved = false
  let published = false
  let committed = false
  try {
    signal.throwIfAborted()
    // rename provides the existence check without following links or deleting old files.
    try {
      await move(destination, backup)
      saved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    signal.throwIfAborted()
    await move(staging, destination)
    published = true
    if (!validate(destination)) throw new Error('download-failed')
    signal.throwIfAborted()
    committed = true
  } catch (error) {
    if (published) await rm(destination, { recursive: true, force: true })
    if (saved) await move(backup, destination)
    saved = false
    throw error
  } finally {
    // A failed rollback keeps its backup for recovery rather than discarding it.
    if (committed || !saved)
      await rm(backupRoot, { recursive: true, force: true }).catch(() => {})
  }
}
