import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../dist/store/index.js'
import { SkillPluginService } from '../../dist/skills/service.js'

export function writePackage(directory, id, options = {}) {
  mkdirSync(directory, { recursive: true })
  const manifest = {
    manifestVersion: 1,
    id,
    name: options.name ?? 'Test Skill',
    version: options.version ?? '1.0.0',
    description: 'Test external skill',
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: options.protocol ?? '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: {
      filesystem: options.filesystem ?? 'workspace-read',
      network: options.network ?? false,
      shell: false,
    },
    skill: { tools: ['file.read'], argumentHint: null },
  }
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(
    join(directory, 'SKILL.md'),
    options.instructions ?? '# Instructions\n\nRead the requested file.\n',
  )
  return manifest
}

export function writeStandardSkill(directory, name, options = {}) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${options.description ?? 'A portable test skill.'}\n${options.extra ?? ''}---\n\n# Instructions\n\nFollow the portable skill.\n`,
  )
}

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reflexion-skill-plugin-'))
  const store = new Store(root)
  const service = new SkillPluginService(store, root, () => {})
  return { root, store, service }
}

export async function waitForTask(service, started) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = service.listTasks().find((item) => item.id === started.id)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`plugin task timed out: ${started.id}`)
}

export async function completed(service, task) {
  const result = await waitForTask(service, task)
  assert.equal(result.status, 'completed', result.error ?? undefined)
  return result
}
