import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolveSystemRuntimeBinary } from '../dist/system.js'
import { startServer, sseBody } from './fixtures/provider-server.mjs'
import { startRuntime } from './fixtures/core-runtime-process.mjs'

const binary = resolveSystemRuntimeBinary()
const git = promisify(execFile)
test(
  'P0 core acceptance: first configuration, streamed chat, save, stage, commit, restart recovery',
  { skip: binary === null },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'reflexion-core-acceptance-'))
    const workspace = join(root, 'workspace')
    const data = join(root, 'data')
    mkdirSync(workspace)
    const file = join(workspace, 'note.txt')
    writeFileSync(file, 'before\n')
    await git('git', ['init', '-q', workspace])
    await git('git', ['-C', workspace, 'config', 'user.name', 'Acceptance'])
    await git('git', [
      '-C',
      workspace,
      'config',
      'user.email',
      'acceptance@example.invalid',
    ])
    await git('git', ['-C', workspace, 'add', 'note.txt'])
    await git('git', ['-C', workspace, 'commit', '-qm', 'initial'])
    const server = await startServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(sseBody())
    })
    let runtime
    try {
      runtime = await startRuntime(data, binary)
      assert.deepEqual((await runtime.call('provider.list')).profiles, [])
      const { profile } = await runtime.call('provider.configure', {
        name: 'Local acceptance provider',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        models: ['acceptance-model'],
        // Synthetic placeholder for the isolated local server, never a real credential.
        secret: 'acceptance-placeholder',
        apiFormat: 'openai-chat',
        enabled: true,
      })
      const createId = randomUUID()
      const { project } = await runtime.call(
        'project.create',
        { folderPath: workspace, name: 'Acceptance' },
        createId,
      )
      assert.equal(
        (
          await runtime.call(
            'project.create',
            { folderPath: workspace, name: 'Acceptance' },
            createId,
          )
        ).project.id,
        project.id,
      )
      assert.equal((await runtime.call('project.list')).projects.length, 1)
      const { session } = await runtime.call('session.create', {
        projectId: project.id,
        title: 'Core acceptance',
      })
      const sendId = randomUUID()
      const payload = {
        sessionId: session.id,
        content: 'Reply with Hello.',
        providerId: profile.id,
        model: 'acceptance-model',
      }
      const sent = await runtime.call('message.send', payload, sendId)
      assert.equal(
        (await runtime.call('message.send', payload, sendId)).runId,
        sent.runId,
      )
      await runtime.waitFor(
        (message) =>
          message.method === 'run.completed' &&
          message.params.runId === sent.runId,
      )
      const history = await runtime.call('session.get', {
        sessionId: session.id,
      })
      assert.equal(
        history.messages.filter((message) => message.role === 'user').length,
        1,
      )
      assert.ok(
        history.messages.some(
          (message) =>
            message.role === 'assistant' && message.content === 'Hello',
        ),
      )
      assert.ok(
        runtime.events.some(
          (event) =>
            event.method === 'message.delta' &&
            event.params.runId === sent.runId,
        ),
      )
      const read = await runtime.call('workspace.read_file', {
        projectId: project.id,
        path: 'note.txt',
      })
      const writeId = randomUUID()
      const save = {
        projectId: project.id,
        path: 'note.txt',
        content: 'after\n',
        readToken: read.readToken,
      }
      const saved = await runtime.call('workspace.write_file', save, writeId)
      assert.equal(
        (await runtime.call('workspace.write_file', save, writeId)).readToken,
        saved.readToken,
      )
      assert.equal(readFileSync(file, 'utf8'), 'after\n')
      // A stale editor cannot overwrite a newer successful save.
      await assert.rejects(
        runtime.call('workspace.write_file', { ...save, content: 'stale\n' }),
        /changed|conflict|变化|过期|陈旧/i,
      )
      const stageId = randomUUID()
      const paths = { projectId: project.id, paths: ['note.txt'] }
      await Promise.all([
        runtime.call('workspace.git_stage', paths, stageId),
        runtime.call('workspace.git_stage', paths, stageId),
      ])
      const status = await runtime.call('workspace.git_status', {
        projectId: project.id,
      })
      assert.ok(
        status.entries.some(
          (entry) => entry.path === 'note.txt' && entry.staged,
        ),
      )
      const commitId = randomUUID()
      const commit = { projectId: project.id, message: 'acceptance change' }
      await runtime.call('workspace.git_commit', commit, commitId)
      await runtime.call('workspace.git_commit', commit, commitId)
      assert.equal(
        (
          await git('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'])
        ).stdout.trim(),
        '2',
      )
      assert.equal(
        (await runtime.call('workspace.git_status', { projectId: project.id }))
          .entries.length,
        0,
      )
      assert.equal(
        (
          await runtime.call('operation.get', {
            method: 'workspace.git_commit',
            targetRequestId: commitId,
          })
        ).operation.phase,
        'succeeded',
      )
      assert.ok(
        !JSON.stringify(runtime.events).includes('acceptance-placeholder'),
      )
      await runtime.stop()
      runtime = null
      runtime = await startRuntime(data, binary)
      assert.equal(
        (await runtime.call('provider.list')).profiles[0].id,
        profile.id,
      )
      assert.equal(
        (await runtime.call('project.list')).projects[0].id,
        project.id,
      )
      const restored = await runtime.call('session.get', {
        sessionId: session.id,
      })
      assert.deepEqual(
        restored.messages.map((message) => [
          message.id,
          message.content,
          message.status,
        ]),
        history.messages.map((message) => [
          message.id,
          message.content,
          message.status,
        ]),
      )
      assert.equal(restored.runs[0].status, 'completed')
      assert.equal(
        (
          await runtime.call('workspace.read_file', {
            projectId: project.id,
            path: 'note.txt',
          })
        ).content,
        'after\n',
      )
      assert.equal(
        (await runtime.call('workspace.git_status', { projectId: project.id }))
          .entries.length,
        0,
      )
      assert.equal(
        (
          await runtime.call('operation.get', {
            method: 'workspace.git_commit',
            targetRequestId: commitId,
          })
        ).operation,
        null,
      )
    } finally {
      if (runtime) await runtime.stop()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  },
)
