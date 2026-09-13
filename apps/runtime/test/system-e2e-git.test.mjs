import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
 * Git 写操作与提交历史端到端（真实 Rust 二进制 + 真实 git CLI）。
 *
 * 覆盖协议缝：workspace.git_* → 串行队列 → git.stage/commit/push/fetch/
 * pull/branch_*、remote_add/remote_remove 的 argv 拼装与错误透出，
 * git_log/commit_files/commit_diff 历史链与 startRef 导航，以及远程生命周期
 * （add→fetch→远程分支检出为本地跟踪→remove）。remote 用 file:// 裸仓库，
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

test(
  'workspace.git_log/commit_files/commit_diff history chain against real binary',
  { skip: BINARY === null },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-histe2e-'))
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const git = async (...args) => {
      const { stdout } = await execFileAsync('git', args)
      return stdout
    }
    const headHash = async () =>
      (await git('-C', repo, 'rev-parse', 'HEAD')).trim()
    await git('init', '-q', repo)
    await git('-C', repo, 'config', 'user.name', 'e2e')
    await git('-C', repo, 'config', 'user.email', 'e2e@example.com')

    // 提交 1：init（seed.txt）。
    const seedV1 = 'seed\n'
    writeFileSync(join(repo, 'seed.txt'), seedV1)
    await git('-C', repo, 'add', 'seed.txt')
    await git('-C', repo, 'commit', '-qm', 'init')
    const firstHash = await headHash()
    // 提交 2：新增 x.txt。
    const xV1 = 'x line1\nx line2\nx line3\n'
    writeFileSync(join(repo, 'x.txt'), xV1)
    await git('-C', repo, 'add', 'x.txt')
    await git('-C', repo, 'commit', '-qm', 'feat: add x')
    const secondHash = await headHash()
    // 提交 3：修改 seed.txt + git mv 重命名 x.txt（保持高相似 → R 而非 D+A）。
    const seedV2 = 'seed\nseed edited\n'
    const xV2 = 'x line1\nx line2\nx line3\nx line4 appended\n'
    writeFileSync(join(repo, 'seed.txt'), seedV2)
    await git('-C', repo, 'mv', 'x.txt', 'x-new.txt')
    writeFileSync(join(repo, 'x-new.txt'), xV2)
    await git('-C', repo, 'add', '-A')
    await git('-C', repo, 'commit', '-qm', 'refactor: rename+edit')
    const thirdHash = await headHash()

    const store = new Store(join(dir, 'data'))
    const project = store.projects.create({
      name: 'history-e2e',
      folderPath: repo,
    })
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const ctx = { store, system: client }
      const call = (method, params) =>
        dispatchCommand(method, { requestId: 'req-histe2e', ...params }, ctx)

      // git_log：全量 → 3 条、最新在前、无 hasMore、非 merge、时间戳与哈希形态。
      const log = await call('workspace.git_log', { projectId: project.id })
      assert.equal(log.repo, true)
      assert.deepEqual(
        log.commits.map((c) => c.subject),
        ['refactor: rename+edit', 'feat: add x', 'init'],
      )
      assert.equal(log.hasMore, false)
      for (const commit of log.commits) {
        assert.equal(commit.isMerge, false)
        assert.ok(commit.timestampMs > 0)
        assert.match(commit.hash, /^[0-9a-f]{40}$/)
      }
      assert.equal(log.commits[0].hash, thirdHash)
      assert.ok(thirdHash.startsWith(log.commits[0].shortHash))

      // 分页：skip=1 limit=1 → 中间那条，仍有后续。
      const paged = await call('workspace.git_log', {
        projectId: project.id,
        skip: 1,
        limit: 1,
      })
      assert.equal(paged.commits.length, 1)
      assert.equal(paged.commits[0].subject, 'feat: add x')
      assert.equal(paged.hasMore, true)

      // commit_files（第 3 个提交）：rename 带 oldPath + modify 各一条。
      const { files } = await call('workspace.git_commit_files', {
        projectId: project.id,
        hash: thirdHash,
      })
      const renamed = files.find((f) => f.path === 'x-new.txt')
      assert.deepEqual(renamed, {
        path: 'x-new.txt',
        oldPath: 'x.txt',
        status: 'renamed',
      })
      const modified = files.find((f) => f.path === 'seed.txt')
      assert.deepEqual(modified, {
        path: 'seed.txt',
        status: 'modified',
      })

      // commit_diff：rename 后的新路径 → original 取自父提交的旧路径内容。
      const renameDiff = await call('workspace.git_commit_diff', {
        projectId: project.id,
        hash: thirdHash,
        path: 'x-new.txt',
      })
      assert.equal(renameDiff.original, xV1)
      assert.equal(renameDiff.modified, xV2)
      // 新增侧：original 为空。
      const addedDiff = await call('workspace.git_commit_diff', {
        projectId: project.id,
        hash: secondHash,
        path: 'x.txt',
      })
      assert.equal(addedDiff.original, '')
      assert.equal(addedDiff.modified, xV1)
      // 未改动路径：两侧一致且非空（钉住该行为）。
      const unchangedDiff = await call('workspace.git_commit_diff', {
        projectId: project.id,
        hash: secondHash,
        path: 'seed.txt',
      })
      assert.equal(unchangedDiff.original, seedV1)
      assert.equal(unchangedDiff.modified, seedV1)

      // 历史导航端到端：基于首个 commit 建分支（不切换），rev-parse 验证落点。
      assert.deepEqual(
        await call('workspace.git_branch_create', {
          projectId: project.id,
          name: 'hist-base',
          checkout: false,
          startRef: firstHash,
        }),
        { ok: true },
      )
      assert.equal(
        (await git('-C', repo, 'rev-parse', 'hist-base')).trim(),
        firstHash,
      )

      // 分离头导航（命令层钉住 I-1：branch_switch 走 ref-only switch，
      // hex → switch --detach）：切到首个 commit → log 照常、status 无分支，
      // 切回默认分支 → 状态恢复。
      const defaultBranch = (
        await git('-C', repo, 'symbolic-ref', '--short', 'HEAD')
      ).trim()
      assert.deepEqual(
        await call('workspace.git_branch_switch', {
          projectId: project.id,
          name: firstHash,
        }),
        { ok: true },
      )
      const detachedLog = await call('workspace.git_log', {
        projectId: project.id,
      })
      assert.deepEqual(
        detachedLog.commits.map((c) => c.subject),
        ['init'],
      )
      const detached = await call('workspace.git_status', {
        projectId: project.id,
      })
      assert.equal(detached.branch, null)
      assert.deepEqual(
        await call('workspace.git_branch_switch', {
          projectId: project.id,
          name: defaultBranch,
        }),
        { ok: true },
      )
      const reattached = await call('workspace.git_status', {
        projectId: project.id,
      })
      assert.equal(reattached.branch, defaultBranch)

      // 注入钉：非法 hash 在 runtime 层（进 Rust 前）即被 requireHash 拒绝。
      await assert.rejects(
        call('workspace.git_commit_files', {
          projectId: project.id,
          hash: 'HEAD',
        }),
        /hash/,
      )
    } finally {
      await client.shutdown()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'git remotes lifecycle e2e: add/fetch/remote-tracking/remove against real binary',
  { skip: BINARY === null },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-reme2e-'))
    const repo = join(dir, 'repo')
    const remote = join(dir, 'remote.git')
    const pwned = '/tmp/pwned-R5'
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
    // 裸仓库拿 commit 用「直推 URL」而非命名 remote：repo 侧 refs/remotes
    // 保持为空，origin/<branch> 只能来自被测的 workspace.git_fetch。
    const remoteUrl = pathToFileURL(remote).href
    await git('-C', repo, 'push', '-q', remoteUrl, defaultBranch)

    const store = new Store(join(dir, 'data'))
    const project = store.projects.create({
      name: 'remotes-e2e',
      folderPath: repo,
    })
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const ctx = { store, system: client }
      const call = (method, params) =>
        dispatchCommand(method, { requestId: 'req-reme2e', ...params }, ctx)

      // 已提交仓库、尚无 remote。
      assert.deepEqual(
        await call('workspace.git_remotes', { projectId: project.id }),
        { repo: true, remotes: [] },
      )

      // 注入钉：ext:: 危险传输（含空格）在 Rust spawn git 前即拒绝——
      // 载荷不执行（/tmp/pwned-R5 不存在）、remote 不落 config。
      await assert.rejects(
        call('workspace.git_remote_add', {
          projectId: project.id,
          name: 'origin',
          url: 'ext::sh -c touch% /tmp/pwned-R5',
        }),
        /invalid remote url/,
      )
      assert.equal(existsSync(pwned), false)
      assert.deepEqual(
        (await call('workspace.git_remotes', { projectId: project.id }))
          .remotes,
        [],
      )

      // 非法 remote name（'@' 走分支名白名单共用规则）：spawn git 前即拒绝。
      await assert.rejects(
        call('workspace.git_remote_add', {
          projectId: project.id,
          name: 'inv@lid',
          url: 'file:///tmp/ok-R5.git',
        }),
        /invalid branch name/,
      )
      assert.deepEqual(
        (await call('workspace.git_remotes', { projectId: project.id }))
          .remotes,
        [],
      )

      // 合法 file:// remote：add 后 list 可见；干净 URL 原样回显（不误遮蔽）。
      assert.deepEqual(
        await call('workspace.git_remote_add', {
          projectId: project.id,
          name: 'origin',
          url: remoteUrl,
        }),
        { ok: true },
      )
      assert.deepEqual(
        (await call('workspace.git_remotes', { projectId: project.id }))
          .remotes,
        [{ name: 'origin', url: remoteUrl }],
      )

      // fetch 前 refs/remotes 为空（钉住「直推 URL 不留跟踪 ref」前提）。
      const beforeFetch = await call('workspace.git_branches', {
        projectId: project.id,
      })
      assert.deepEqual(beforeFetch.remoteBranches, [])

      // fetch（origin 此刻存在）→ remoteBranches 出现 origin/<branch>。
      assert.deepEqual(
        await call('workspace.git_fetch', { projectId: project.id }),
        { ok: true },
      )
      const remoteRef = `origin/${defaultBranch}`
      const afterFetch = await call('workspace.git_branches', {
        projectId: project.id,
      })
      assert.ok(
        afterFetch.remoteBranches.includes(remoteRef),
        `remoteBranches was ${JSON.stringify(afterFetch.remoteBranches)}`,
      )

      // 远程分支检出为本地跟踪分支（VS Code 行为：switch -c <name> origin/x
      // 在 branch.autoSetupMerge 默认下建立 upstream）。
      assert.deepEqual(
        await call('workspace.git_branch_create', {
          projectId: project.id,
          name: 'local-from-remote',
          checkout: true,
          startRef: remoteRef,
        }),
        { ok: true },
      )
      const tracked = await call('workspace.git_branches', {
        projectId: project.id,
      })
      assert.equal(tracked.current, 'local-from-remote')
      assert.ok(tracked.branches.includes('local-from-remote'))
      // tracking 用裸 git 对账，不经过被测解析层。
      assert.equal(
        (
          await git(
            '-C',
            repo,
            'rev-parse',
            '--abbrev-ref',
            'local-from-remote@{upstream}',
          )
        ).trim(),
        remoteRef,
      )

      // 移除 remote：git remote remove 连 refs/remotes/origin/* 一并删除
      // （无 stale 残留），本地分支与其检出状态不受影响。
      assert.deepEqual(
        await call('workspace.git_remote_remove', {
          projectId: project.id,
          name: 'origin',
        }),
        { ok: true },
      )
      assert.deepEqual(
        (await call('workspace.git_remotes', { projectId: project.id }))
          .remotes,
        [],
      )
      const afterRemove = await call('workspace.git_branches', {
        projectId: project.id,
      })
      assert.deepEqual(afterRemove.remoteBranches, [])
      assert.equal(afterRemove.current, 'local-from-remote')
    } finally {
      await client.shutdown()
      store.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(pwned, { force: true })
    }
  },
)
