import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeMethodNames } from '../packages/contracts/dist/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = join(
  ROOT,
  'packages/contracts/generated/runtime-methods.json',
)
const methods = [...runtimeMethodNames, 'system.ping'].sort()

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(
  outputPath,
  `${JSON.stringify({ version: 1, methods }, null, 2)}\n`,
)
console.log(`Generated ${methods.length} runtime methods`)
