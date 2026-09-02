// contracts 命令清单 ↔ 生成产物一致性校验。
// 用法：先 pnpm build:packages，再 node scripts/check-whitelist.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeMethodNames } from '../packages/contracts/dist/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'packages/contracts/generated/runtime-methods.json')
const LIB_RS = join(ROOT, 'apps/desktop/src-tauri/src/lib.rs')

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const registry = [...runtimeMethodNames].sort()
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const methods = manifest.methods
const uniqueMethods = [...new Set(methods)]
const expected = [...registry, 'system.ping'].sort()
const libRs = readFileSync(LIB_RS, 'utf8')

check('generated manifest is versioned', manifest.version === 1)
check(
  'generated manifest methods are sorted',
  JSON.stringify(methods) === JSON.stringify([...methods].sort()),
)
check(
  'generated manifest has no duplicates',
  uniqueMethods.length === methods.length,
)
check(
  'contracts manifest covers all commands',
  JSON.stringify(methods) === JSON.stringify(expected),
  `expected ${expected.length}, got ${methods.length}`,
)
check(
  'Host includes generated whitelist',
  libRs.includes('include!(concat!(env!("OUT_DIR"), "/runtime_methods.rs"));'),
)
check('system.ping is explicitly preserved', methods.includes('system.ping'))
check(
  'workspace.git_branches is allowlisted',
  methods.includes('workspace.git_branches'),
)

if (failures > 0) {
  console.error(`check-whitelist: ${failures} failure(s)`)
  process.exit(1)
}
console.log('check-whitelist: all checks passed')
