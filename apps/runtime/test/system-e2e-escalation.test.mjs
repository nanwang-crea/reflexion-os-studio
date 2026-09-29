import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'
import { createShellExecuteTool } from '../dist/agent/tools/shell.js'
import { ShellOutputStore } from '../dist/agent/tools/shell-output.js'

const localBinary = fileURLToPath(
  new URL(
    `../../../crates/target/debug/reflexion-system-runtime${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)
const binary =
  resolveSystemRuntimeBinary() ?? (existsSync(localBinary) ? localBinary : null)
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for system/approval')
}

// Entire model-tool → approval → grant → real Rust/OS path; no handcrafted grant.
test(
  'approved explicit scope works for implicit writes, rejects sibling writes, denial and cancellation execute nothing',
  { skip: binary === null },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-escalation-e2e-'))
    const workspace = join(dir, 'workspace')
    const approved = join(dir, 'approved with spaces')
    const denied = join(dir, 'not approved')
    for (const path of [workspace, approved, denied]) mkdirSync(path)
    const store = new Store(join(dir, 'store'))
    const client = new SystemRuntimeClient(binary, [], () => {})
    client.start()
    try {
      await until(() => client.available)
      // Platform runner must provide its actual sandbox; never silently skip a broken provider.
      assert.notEqual(
        client.sandboxName,
        'none',
        'OS sandbox required for this integration test',
      )
      const project = store.projects.create({
        name: 'e2e',
        folderPath: workspace,
      })
      const session = store.sessions.create(project.id)
      const run = store.runs.create({
        sessionId: session.id,
        providerId: 'test',
        model: 'test',
      })
      const approvals = new ApprovalGateway()
      const registry = new ToolRegistry()
      registry.register(
        createShellExecuteTool(client, workspace, new ShellOutputStore()),
      )
      const events = []
      const input = {
        store,
        run,
        approvals,
        registry,
        system: client,
        workspaceRoot: workspace,
        sandboxProvider: client.sandboxName,
        permissionDomainId: session.id,
        rootRunId: run.id,
        gate: new PermissionGate({
          preset: 'workspace-read',
          hasWorkspace: true,
          approvalOverride: 'default',
          dangerActive: () => false,
        }),
        emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
        state: createRunExecutionState(),
      }
      const quote = (path) => `"${path}"`
      const script = join(workspace, 'implicit.cjs')
      const target = join(approved, 'result.txt')
      const sibling = join(denied, 'blocked.txt')
      writeFileSync(
        script,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'approved'); try { fs.writeFileSync(${JSON.stringify(sibling)}, 'bad'); process.exitCode = 3 } catch {} `,
      )
      const request = {
        id: 'escalation-e2e',
        name: 'shell.execute',
        arguments: JSON.stringify({
          command: `${quote(process.execPath)} ${quote(script)}`,
          sandbox_permissions: 'require_escalated',
          justification: 'Export into approved folder',
          additional_write_roots: [approved],
        }),
      }
      const resultPromise = executeToolCall(
        input,
        request,
        new AbortController().signal,
      )
      await until(() => events.some((e) => e.type === 'approval.required'))
      const card = events.find((e) => e.type === 'approval.required')
      assert.deepEqual(card.subject.escalationRoots, [realpathSync(approved)])
      assert.equal(
        existsSync(target),
        false,
        'must not execute before approval',
      )
      approvals.resolveChoice(card.toolCallId, 'allow-once')
      const result = await resultPromise
      assert.equal(result.isError, false, result.content)
      assert.equal(JSON.parse(result.content).exitCode, 0, result.content)
      assert.equal(readFileSync(target, 'utf8'), 'approved')
      assert.equal(
        existsSync(sibling),
        false,
        'scope must not include siblings',
      )

      for (const action of ['deny', 'cancel']) {
        const marker = join(approved, `${action}.txt`)
        writeFileSync(
          script,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
        )
        events.length = 0
        const controller = new AbortController()
        const pending = executeToolCall(
          input,
          { ...request, id: action },
          controller.signal,
        ).catch((error) => error)
        await until(() => events.some((e) => e.type === 'approval.required'))
        const next = events.find((e) => e.type === 'approval.required')
        if (action === 'deny') approvals.resolveChoice(next.toolCallId, 'deny')
        else controller.abort()
        const outcome = await pending
        assert.ok(outcome.isError || outcome.name === 'AbortError')
        assert.equal(existsSync(marker), false)
      }

      // Changing the canonical target while a card is pending cannot redirect permission.
      if (process.platform !== 'win32') {
        events.length = 0
        const safe = join(dir, 'safe')
        mkdirSync(safe)
        const moving = join(safe, 'moving')
        mkdirSync(moving)
        const raceRequest = {
          ...request,
          id: 'race',
          arguments: JSON.stringify({
            command: 'echo should-not-run',
            sandbox_permissions: 'require_escalated',
            justification: 'race regression',
            additional_write_roots: [moving],
          }),
        }
        const pending = executeToolCall(
          input,
          raceRequest,
          new AbortController().signal,
        )
        await until(() => events.some((e) => e.type === 'approval.required'))
        rmSync(moving, { recursive: true })
        symlinkSync(denied, moving)
        approvals.resolveChoice(
          events.find((e) => e.type === 'approval.required').toolCallId,
          'allow-once',
        )
        const outcome = await pending
        assert.equal(outcome.isError, true)
        assert.equal(outcome.code, 'approval_subject_mismatch')
      }
    } finally {
      await client.shutdown()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
