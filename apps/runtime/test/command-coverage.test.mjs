import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandSchemaRegistry,
  jsonSchemas,
  runtimeMethodNames,
} from '@reflexion-os-studio/contracts'
import { commandHandlers } from '../dist/handlers.js'

// These commands are intentionally handled in index.ts because they have
// transport-level behavior that dispatchCommand does not need to own.
const inlineRuntimeHandlers = new Set([
  'runtime.get_status',
  'provider.test',
  'file.write',
  'file.edit',
  'file.delete',
  'file.move',
])

test('every contract command is covered by a runtime handler', () => {
  const missing = runtimeMethodNames.filter(
    (method) => !commandHandlers[method] && !inlineRuntimeHandlers.has(method),
  )
  assert.deepEqual(
    missing,
    [],
    `missing runtime handlers: ${missing.join(', ')}`,
  )
})

test('runtime handlers do not exist without a contract schema', () => {
  const orphaned = Object.keys(commandHandlers).filter(
    (method) => !Object.hasOwn(CommandSchemaRegistry, method),
  )
  assert.deepEqual(
    orphaned,
    [],
    `orphaned runtime handlers: ${orphaned.join(', ')}`,
  )
})

test('command JSON schema registry contains params and response schemas', () => {
  const missing = runtimeMethodNames.flatMap((method) =>
    [`${method}.params`, `${method}.result`].filter(
      (name) => !Object.hasOwn(jsonSchemas, name),
    ),
  )
  assert.deepEqual(
    missing,
    [],
    `missing command schemas: ${missing.join(', ')}`,
  )
})
