import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveInvocation,
  skillsPromptSection,
} from '../dist/skills/invocation.js'

const skill = {
  manifest: {
    id: 'portable-skill',
    name: 'Portable Skill',
    version: '1.0.0',
    description: 'Portable instructions',
    tools: [],
    argumentHint: null,
    whenToUse: null,
    license: null,
    metadata: {},
  },
  instructions: 'Follow the instructions.',
}
const registry = { get: (id) => (id === skill.manifest.id ? skill : null) }

test('skill invocation supports dollar and slash prefixes', () => {
  assert.equal(
    resolveInvocation('$portable-skill run', undefined, registry).via,
    'dollar',
  )
  assert.equal(
    resolveInvocation('/portable-skill run', undefined, registry).via,
    'slash',
  )
  assert.equal(
    resolveInvocation('$unknown run', undefined, registry).via,
    'none',
  )
})

test('skill invocation forwards project scope to the registry', () => {
  const scopedRegistry = {
    get: (id, projectId) =>
      id === skill.manifest.id && projectId === 'project-1' ? skill : null,
  }
  assert.equal(
    resolveInvocation('$portable-skill', undefined, scopedRegistry).skill,
    null,
  )
  assert.equal(
    resolveInvocation('$portable-skill', undefined, scopedRegistry, 'project-1')
      .skill?.manifest.id,
    'portable-skill',
  )
})

test('skill metadata prompt truncates descriptions and degrades to names', () => {
  const longDescription = 'x'.repeat(400)
  const prompt = skillsPromptSection([
    { ...skill.manifest, description: longDescription },
  ])
  assert.equal(prompt.includes('x'.repeat(251)), false)

  const crowded = skillsPromptSection(
    Array.from({ length: 30 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: longDescription,
      argumentHint: null,
    })),
  )
  assert.equal(crowded.includes(longDescription.slice(0, 20)), false)
  assert.equal(crowded.includes('$skill-0 — Skill 0'), true)
})

test('skill metadata prompt includes ZCode when_to_use trigger guidance', () => {
  const prompt = skillsPromptSection([
    {
      ...skill.manifest,
      whenToUse: 'Use when a portable workflow is requested.',
    },
  ])
  assert.match(prompt, /触发时机：Use when a portable workflow is requested\./)
})
