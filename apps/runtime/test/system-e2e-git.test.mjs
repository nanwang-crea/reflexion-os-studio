import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'

/**
 * Git 写操作端到端（真实 Rust 二进制 + 真实 git CLI）。
 *
 * 覆盖协议缝：workspace.git_* → 串行队列 → git.stage/commit/push/fetch/
 * pull/branch_* 的 argv 拼装与错误透出。remote 用 file:// 裸仓库，
 * 全程无网络、无凭据，避免 CI flake。无二进制的环境跳过，不误报。
 */

const execFileAsync = promisify(execFile)
const BINARY = resolveSystemRuntimeBinary()

async function waitReady(client) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (client.available) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('system runtime not ready within 10s')
}

test(
  'git write ops e2e: stage/commit/push/fetch/pull/branch against real binary',
  { skip: BINARY === null },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-gite2e-'))
    const repo = join(dir, 'repo')
    const remote = join(dir, 'remote.git')
    mkdirSync(repo)
    mkdirSync(remote)
    const git = async (...args) => {
      const { stdout } = await execFileAsync('git', args)
      return stdout
    }
    await git('init', '-q', repo)
    await git('-C', repo, 'config', 'user.name', 'e2e')
    await git('-C', repo, 'config', 'user.email', 'e2e@example.com')
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    await git('-C', repo, 'add', 'seed.txt')
    await git('-C', repo, 'commit', '-qm', 'chore: seed')
    const defaultBranch = (
      await git('-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    ).trim()
    await git('init', '-q', '--bare', remote)
    await git('-C', repo, 'remote', 'add', 'origin', pathToFileURL(remote).href)
    const store = new Store(join(dir, 'data'))
    const project = store.projects.create({
      name: 'git-e2e',
      folderPath: repo,
    })
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const ctx = { store, system: client }
      const call = (method, params) =>
        dispatchCommand(method, { requestId: 'req-gite2e', ...params }, ctx)

      const first = await call('workspace.git_status', {
        projectId: project.id,
      })
      assert.equal(first.repo, true)
      assert.equal(first.branch, defaultBranch)

      // stage → commit（Rust 枚举 argv + git-queue 串行）。
      writeFileSync(join(repo, 'new.txt'), 'fresh file\n')
      assert.deepEqual(
        await call('workspace.git_stage', {
          projectId: project.id,
          paths: ['new.txt'],
        }),
        { ok: true },
      )
      assert.deepEqual(
        await call('workspace.git_commit', {
          projectId: project.id,
          message: 'feat: add new file',
        }),
        { ok: true },
      )
      // 空暂存区再提交：服务端兜底拒绝，git 摘要（stdout 末行）进错误消息。
      await assert.rejects(
        call('workspace.git_commit', {
          projectId: project.id,
          message: 'feat: nothing staged',
        }),
        /nothing to commit|no changes added/i,
      )

      // 无 upstream 首推：git push -u origin <branch> 落到 file:// 裸仓库。
      assert.deepEqual(
        await call('workspace.git_push', { projectId: project.id }),
        { ok: true },
      )
      const remoteLog = await git('-C', remote, 'log', '--oneline', 'HEAD')
      assert.match(remoteLog, /feat: add new file/)

      // fetch（origin 已存在）与 pull --ff-only（已同步 → no-op 成功）。
      assert.deepEqual(
        await call('workspace.git_fetch', { projectId: project.id }),
        { ok: true },
      )
      assert.deepEqual(
        await call('workspace.git_pull', { projectId: project.id }),
        { ok: true },
      )

      // 分支创建（checkout）与切回；脏 buffer 守卫属前端逻辑，此处验证 Rust 侧。
      assert.deepEqual(
        await call('workspace.git_branch_create', {
          projectId: project.id,
          name: 'feature/x',
          checkout: true,
        }),
        { ok: true },
      )
      const onFeature = await call('workspace.git_status', {
        projectId: project.id,
      })
      assert.equal(onFeature.branch, 'feature/x')
      assert.deepEqual(
        await call('workspace.git_branch_switch', {
          projectId: project.id,
          name: defaultBranch,
        }),
        { ok: true },
      )
      const back = await call('workspace.git_status', {
        projectId: project.id,
      })
      assert.equal(back.branch, defaultBranch)

      // ahead/behind 是尽力而为指示器：只断言类型，不断言值。
      assert.equal(back.entries.length, 0)
      assert.ok(back.upstream === null || typeof back.upstream === 'string')
      assert.ok(back.ahead === null || typeof back.ahead === 'number')
      assert.ok(back.behind === null || typeof back.behind === 'number')
    } finally {
      await client.shutdown()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
