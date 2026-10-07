// Phase 1B Workspace Surface 冒烟：索引生命周期 + 文件树/查看器按需加载。
// 覆盖：project.create → index.start → status 轮询到 completed（忽略目录不计入）
//   → list_dir 根目录 → read_file 内容 → .. 越权被拒 → idle 时 cancel 为 false →
//   git.diff 两侧内容（untracked/删除/staged）→ runtime 干净退出。
// 用法：先 pnpm build:packages（+ cargo build），再 node scripts/smoke-workspace.mjs
// --packaged 使用随包 Node/Runtime/System Runtime，在独立 cwd 验证资源启动。
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv.includes('--packaged')
const resources = join(ROOT, 'apps/desktop/src-tauri/package-resources')
const TS_ENTRY = packaged
  ? join(resources, 'runtime', 'runtime.mjs')
  : join(ROOT, 'apps/runtime/dist/index.js')
const NODE = packaged
  ? join(
      resources,
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
  : process.execPath
const SYSTEM = packaged
  ? join(
      resources,
      'bin',
      process.platform === 'win32'
        ? 'reflexion-system-runtime.exe'
        : 'reflexion-system-runtime',
    )
  : process.env.REFLEXION_SYSTEM_RUNTIME_BIN

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
  const child = spawn(
    NODE,
    ['--disable-warning=ExperimentalWarning', '--', TS_ENTRY],
    {
      cwd: packaged ? dataDir : ROOT,
      env: {
        ...process.env,
        REFLEXION_DATA_DIR: dataDir,
        ...(SYSTEM ? { REFLEXION_SYSTEM_RUNTIME_BIN: SYSTEM } : {}),
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  const events = []
  const pending = new Map()
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
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`request timed out: ${method}`))
      }, 15_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
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
      if (child.exitCode === null) child.kill()
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言。
      }
    },
  }
}

/** git diff 两侧内容冒烟：untracked（全新增）/ 删除（全移除）/ staged（HEAD→索引）。 */
async function checkGitDiff(runtime, projectId, wsRoot) {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
  } catch {
    console.log('SKIP git_diff checks — git not available')
    return
  }
  const git = (args) => {
    execFileSync('git', args, { cwd: wsRoot, stdio: 'pipe' })
  }
  git(['init', '-q'])
  writeFileSync(join(wsRoot, 'tracked.txt'), 'old content\n')
  git(['add', '.'])
  git([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-qm',
    'init',
  ])
  writeFileSync(
    join(wsRoot, 'src', 'app.ts'),
    'export const x = 42\nmodified\n',
  )
  writeFileSync(join(wsRoot, 'untracked.txt'), 'whole new file\n')
  rmSync(join(wsRoot, 'README.md'))

  const modified = await runtime.request(20, 'workspace.git_diff', {
    projectId,
    path: 'src/app.ts',
  })
  check(
    'git_diff modified file: index → worktree',
    modified.result?.repo === true &&
      modified.result?.original === 'export const x = 42\n' &&
      modified.result?.modified === 'export const x = 42\nmodified\n',
    JSON.stringify(modified.result ?? modified.error),
  )

  const untracked = await runtime.request(21, 'workspace.git_diff', {
    projectId,
    path: 'untracked.txt',
  })
  check(
    'git_diff untracked file: empty → full content',
    untracked.result?.original === '' &&
      untracked.result?.modified === 'whole new file\n',
    JSON.stringify(untracked.result ?? untracked.error),
  )

  git(['add', 'untracked.txt'])
  const staged = await runtime.request(22, 'workspace.git_diff', {
    projectId,
    path: 'untracked.txt',
    staged: true,
  })
  check(
    'git_diff staged new file: HEAD absent → index content',
    staged.result?.original === '' &&
      staged.result?.modified === 'whole new file\n',
    JSON.stringify(staged.result ?? staged.error),
  )

  const deleted = await runtime.request(23, 'workspace.git_diff', {
    projectId,
    path: 'README.md',
  })
  check(
    'git_diff deleted file: index content → empty',
    deleted.result?.original === '# smoke\n' && deleted.result?.modified === '',
    JSON.stringify(deleted.result ?? deleted.error),
  )
}

;(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-ws-smoke-'))
  const wsRoot = mkdtempSync(join(tmpdir(), 'reflexion 工作目录-'))
  mkdirSync(join(wsRoot, 'src'), { recursive: true })
  mkdirSync(join(wsRoot, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(wsRoot, 'README.md'), '# smoke\n')
  writeFileSync(join(wsRoot, 'src', 'app.ts'), 'export const x = 42\n')
  writeFileSync(join(wsRoot, 'node_modules', 'pkg', 'index.js'), 'ignored\n')

  try {
    const runtime = startRuntime(dataDir)
    try {
      // 等待 runtime 就绪；workspace 文件/git 步骤依赖系统通道，
      // 必须等 systemAvailable（Runtime 启动改为 shell 环境快照后异步）。
      let systemReady = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await runtime.request(1, 'runtime.get_status')
        if (
          ready?.result?.state === 'ready' &&
          ready?.result?.systemAvailable
        ) {
          systemReady = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (!systemReady) throw new Error('System Runtime failed to become ready')

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

      const nested = await runtime.request(10, 'workspace.list_dir', {
        projectId: project.id,
        path: process.platform === 'win32' ? 'src\\' : './src',
      })
      check(
        'native directory path returns portable file names',
        nested.result?.entries.some((entry) => entry.path === 'src/app.ts'),
        JSON.stringify(nested.result ?? nested.error),
      )

      const watching = await runtime.request(11, 'workspace.watch_dir', {
        projectId: project.id,
        path: '.',
      })
      check(
        'root directory watcher starts',
        typeof watching.result?.watchId === 'string',
      )
      const eventName = 'watch-created.txt'
      writeFileSync(join(wsRoot, eventName), 'watch fixture')
      let changed = false
      for (let attempt = 0; attempt < 50; attempt++) {
        changed = runtime.events.some(
          (event) =>
            event.type === 'workspace.changed' &&
            event.projectId === project.id &&
            event.path === eventName,
        )
        if (changed) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      check('watcher emits portable workspace-relative paths', changed)
      await runtime.request(12, 'workspace.unwatch_dir', {
        watchId: watching.result?.watchId,
      })
      rmSync(join(wsRoot, eventName))

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

      await checkGitDiff(runtime, project.id, wsRoot)

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
