import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { createShellExecuteTool } from '../dist/agent/tools/shell.js'
import { ShellOutputStore } from '../dist/agent/tools/shell-output.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import {
  freshContext,
  shellRequest,
} from './fixtures/shell-permission-context.mjs'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import {
  canonicalDigest,
  buildGrantV2,
} from '../dist/agent/permissions/index.js'

const localBinary = fileURLToPath(
  new URL(
    `../../../crates/target/debug/reflexion-system-runtime${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)
const binary =
  resolveSystemRuntimeBinary() ?? (existsSync(localBinary) ? localBinary : null)

test(
  'Rust unsandboxed: once grant executes outside workspace, rejects replay, other sources and changed commands',
  { skip: binary === null },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-unsandboxed-'))
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    const target = join(dir, 'outside.txt')
    const script = join(workspace, 'write.cjs')
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'approved')`,
    )
    const command = `"${process.execPath}" "${script}"`
    const client = new SystemRuntimeClient(binary, [], () => {})
    client.start()
    try {
      for (let i = 0; i < 400 && !client.available; i++)
        await new Promise((r) => setTimeout(r, 25))
      assert.ok(client.available, 'sidecar must be ready')
      const makeGrant = (source = 'once', network = true) =>
        buildGrantV2({
          grantId: randomUUID(),
          requestId: randomUUID(),
          sessionId: 'test-session',
          workspaceRoot: workspace,
          operation: 'shell.execute',
          source,
          subjectDigest: canonicalDigest('shell.execute', [
            command,
            '.',
            'unsandboxed',
            network ? '1' : '0',
          ]),
          sandbox: 'unsandboxed',
          sandboxNetwork: network,
        })
      for (const source of ['preset', 'session-rule', 'danger-lease']) {
        await assert.rejects(
          client.request('shell.execute', {
            workspaceRoot: workspace,
            command,
            grant: makeGrant(source),
          }),
          (error) => error.code === 'invalid_grant',
        )
      }
      await assert.rejects(
        client.request('shell.execute', {
          workspaceRoot: workspace,
          command,
          grant: makeGrant('once', false),
        }),
        (error) => error.code === 'invalid_grant',
      )
      assert.equal(existsSync(target), false)
      const ctx = freshContext('workspace-full', true)
      const registry = new ToolRegistry()
      let grant
      registry.register(
        createShellExecuteTool(
          {
            request: async (method, params, options) => {
              grant = params.grant
              return client.request(method, params, options)
            },
          },
          workspace,
          new ShellOutputStore(),
        ),
      )
      const pending = executeToolCall(
        {
          ...ctx.input,
          workspaceRoot: workspace,
          system: client,
          registry,
          emitter: ctx.emitter,
        },
        shellRequest('approved-e2e', command, {
          sandbox_permissions: 'require_unsandboxed',
          justification: 'write the approved external test file',
        }),
        new AbortController().signal,
      )
      try {
        for (
          let i = 0;
          i < 400 && !ctx.events.some((e) => e.type === 'approval.required');
          i++
        )
          await new Promise((r) => setTimeout(r, 25))
        const card = ctx.events.find((e) => e.type === 'approval.required')
        assert.ok(card)
        assert.equal(
          existsSync(target),
          false,
          'no side effect before user approval',
        )
        ctx.approvals.resolveChoice(card.toolCallId, 'allow-once')
        const result = await pending
        assert.equal(result.isError, false)
        const outcome = JSON.parse(result.content)
        assert.equal(outcome.exitCode, 0)
        assert.equal(outcome.sandbox.active, false)
        assert.equal(readFileSync(target, 'utf8'), 'approved')
        rmSync(target)
      } finally {
        ctx.store.close()
      }
      await assert.rejects(
        client.request('shell.execute', {
          workspaceRoot: workspace,
          command: `${command} changed`,
          grant,
        }),
        (error) => error.code === 'approval_subject_mismatch',
      )
      await assert.rejects(
        client.request('shell.execute', {
          workspaceRoot: workspace,
          command,
          grant,
        }),
        (error) => error.code === 'grant_consumed',
      )
      assert.equal(existsSync(target), false, 'replay executes nothing')
    } finally {
      await client.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
