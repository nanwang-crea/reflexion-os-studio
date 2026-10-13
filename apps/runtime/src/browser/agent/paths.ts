import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Development tsc output or self-contained packaged worker beside runtime. */
export function browserWorkerPaths() {
  const directory = dirname(fileURLToPath(import.meta.url))
  const development = join(directory, 'worker', 'index.js')
  if (existsSync(development))
    return {
      worker: development,
      browsers: join(
        directory,
        '..',
        '..',
        '..',
        '..',
        '..',
        '.cache',
        'agent-browser',
      ),
    }
  const worker = join(directory, '..', 'browser', 'worker.mjs')
  return { worker, browsers: join(dirname(worker), 'browsers') }
}
