// Phase 1B Workspace Surface 冒烟：索引生命周期 + 文件树/查看器按需加载。
// 覆盖：project.create → index.start → status 轮询到 completed（忽略目录不计入）
//   → list_dir 根目录 → read_file 内容 → .. 越权被拒 → idle 时 cancel 为 false →
//   runtime 干净退出。
// 用法：先 pnpm build:packages（+ cargo build），再 node scripts/smoke-workspace.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TS_ENTRY = join(ROOT, 'apps/runtime/dist/index.js')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function startRuntime(dataDir) {
  const child = spawn(process.execPath, [TS_ENTRY], {
    env: { ...process.env, REFLEXION_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  const pending = new Map()
  let seq = 0
  let buffer = ''
  const waitExit = new Promise((resolve) => child.on('exit', resolve))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (typeof message.method === 'string' && message.id === undefined) {
        events.push(message.params ?? {})
        continue
      }
      if (typeof message.id === 'number' && !('method' in message)) {
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        }
      }
    }
  })
  const request = (id, method, params = {}) =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, requestId: randomUUID() } })}\n`,
      )
    })
  return {
    child,
    events,
    request,
    waitExit,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言。
      }
    },
  }
}

;(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-ws-smoke-'))
  const wsRoot = mkdtempSync(join(tmpdir(), 'reflexion-ws-proj-'))
  mkdirSync(join(wsRoot, 'src'), { recursive: true })
  mkdirSync(join(wsRoot, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(wsRoot, 'README.md'), '# smoke\n')
  writeFileSync(join(wsRoot, 'src', 'app.ts'), 'export const x = 42\n')
  writeFileSync(join(wsRoot, 'node_modules', 'pkg', 'index.js'), 'ignored\n')

  try {
    const runtime = startRuntime(dataDir)
    try {
      // 等待 runtime 就绪。
      for (let attempt = 0; attempt < 80; attempt++) {
        const ready = await runtime.request(1, 'runtime.get_status')
        if (ready?.result?.state === 'ready') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const created = await runtime.request(2, 'project.create', {
        folderPath: wsRoot,
      })
      const project = created.result.project
      if (!project) {
        throw new Error(`project.create failed: ${JSON.stringify(created)}`)
      }

      const started = await runtime.request(3, 'workspace.index.start', {
        projectId: project.id,
      })
      check('index.start accepted', started.result?.accepted === true)

      let snapshot = null
      for (let attempt = 0; attempt < 80; attempt++) {
        const status = await runtime.request(4, 'workspace.index.status', {
          projectId: project.id,
        })
        snapshot = status.result?.snapshot ?? null
        if (snapshot?.status === 'completed' || snapshot?.status === 'failed') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      check(
        'index completed with ignored dirs excluded',
        snapshot?.status === 'completed' && snapshot.fileCount === 2,
        `status=${snapshot?.status} files=${snapshot?.fileCount}`,
      )
      check('index stats include dirs', snapshot?.dirCount === 1)
      check(
        'ext stats include .ts',
        snapshot?.extStats.some(
          (entry) => entry.ext === '.ts' && entry.files === 1,
        ),
      )

      const listed = await runtime.request(5, 'workspace.list_dir', {
        projectId: project.id,
        path: '.',
      })
      const entries = listed.result?.entries ?? []
      const names = entries.map((entry) => entry.path)
      check(
        'list_dir is a raw listing (indexer ignore lists do not apply)',
        names.includes('README.md') &&
          names.includes('src') &&
          names.includes('node_modules'),
        JSON.stringify(names),
      )

      const read = await runtime.request(6, 'workspace.read_file', {
        projectId: project.id,
        path: 'src/app.ts',
      })
      const content = read.result?.content ?? ''
      check('read_file returns file content', content === 'export const x = 42')

      const traversal = await runtime.request(7, 'workspace.read_file', {
        projectId: project.id,
        path: '../outside.txt',
      })
      const traversalError = traversal.error
      check(
        'read_file rejects path traversal',
        traversalError !== undefined,
        JSON.stringify(traversal),
      )

      const cancelIdle = await runtime.request(8, 'workspace.index.cancel', {
        projectId: project.id,
      })
      check(
        'cancel for idle index returns accepted=false',
        cancelIdle.result?.accepted === false,
      )

      await runtime.request(9, 'runtime.shutdown')
      const exitCode = await Promise.race([
        runtime.waitExit,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
      ])
      check('runtime exits cleanly', exitCode === 0, `code=${String(exitCode)}`)
    } finally {
      runtime.cleanup()
    }
  } catch (error) {
    failures++
    console.error(`FAIL unexpected — ${error.message}`)
  } finally {
    rmSync(wsRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`smoke-workspace: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('smoke-workspace: all checks passed')
})()
