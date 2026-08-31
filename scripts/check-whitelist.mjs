// 契约命令 ↔ Tauri 白名单一致性校验：RUNTIME_METHODS 数组与
// CommandSchemaRegistry 必须同步（白名单可多 system.ping 一项）。
// 用法：先 pnpm build:packages，再 node scripts/check-whitelist.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandSchemaRegistry } from '../packages/contracts/dist/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_RS = join(ROOT, 'apps/desktop/src-tauri/src/lib.rs')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const registry = Object.keys(CommandSchemaRegistry).sort()
const libRs = readFileSync(LIB_RS, 'utf8')
const match = libRs.match(
  /const RUNTIME_METHODS: \[&str; \d+\] = \[([\s\S]*?)\];/,
)
check('lib.rs contains RUNTIME_METHODS array', match !== null)
const whitelist = (match?.[1] ?? '')
  .split(',')
  .map((entry) => entry.trim().replace(/^"|"$/g, ''))
  .filter(Boolean)
  .sort()

const missing = registry.filter((method) => !whitelist.includes(method))
const extra = whitelist.filter(
  (method) => !registry.includes(method) && method !== 'system.ping',
)
check('白名单覆盖全部契约命令', missing.length === 0, missing.join(','))
check('白名单无多余命令(除 system.ping)', extra.length === 0, extra.join(','))

if (failures > 0) {
  console.error(`check-whitelist: ${failures} failure(s)`)
  process.exit(1)
}
console.log('check-whitelist: all checks passed')
