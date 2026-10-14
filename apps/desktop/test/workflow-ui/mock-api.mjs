// Renderer integration fixture: no model/network/real workspace or credentials.
export const workflowApiMock = `
let drafts = [], versions = [], generation = null, detail = null
window.workflowCalls = []; window.validationValid = true
const now = () => new Date().toISOString()
export async function listWorkflows() { return { versions } }
export async function listWorkflowDrafts() { return { drafts } }
export async function listWorkflowGenerations() { return { generations: generation ? [generation] : [] } }
export async function getWorkflowGeneration() { return { generation } }
export async function listWorkflowRuns() { return { runs: detail ? [{ ...detail.run, name: detail.run.snapshot.definition.name }] : [] } }
export async function getWorkflowRun() { return { detail } }
export async function saveWorkflowDraft(input) {
  const draft = { id: 'draft-1', projectId: input.projectId, revision: (drafts[0]?.revision ?? 0) + 1, definitionId: input.definitionId, baseVersion: input.baseVersion, generationId: null, definition: input.definition, createdAt: now(), updatedAt: now() }
  drafts = [draft]; return { draft }
}
export async function generateWorkflow(input) {
  window.workflowCalls.push('generate:' + input.mode)
  let candidate = window.workflowFixture()
  if (input.mode === 'node') {
    candidate = structuredClone(drafts[0].definition)
    const node = structuredClone(candidate.nodes[0]); node.id = 'polisher'; node.name = '语言润色者'
    candidate.edges.push({ from: { nodeId: candidate.nodes.at(-1).id, portKey: 'text' }, to: { nodeId: node.id, portKey: 'text' } })
    candidate.nodes.push(node); candidate.outputs[0].from.nodeId = node.id
  }
  generation = { id: 'generation-1', draftId: drafts[0].id, projectId: input.projectId, stateVersion: 1, baseRevision: drafts[0].revision, mode: input.mode, status: 'ready', candidate, validation: { valid: true, issues: [], order: [] }, tokensUsed: 10, tokensEstimated: false, errorCode: null }
  return { generation }
}
export async function applyWorkflowGeneration() {
  drafts = [{ ...drafts[0], revision: drafts[0].revision + 1, definition: generation.candidate }]
  generation = { ...generation, status: 'applied', stateVersion: generation.stateVersion + 1 }
  return { draft: drafts[0] }
}
export async function editWorkflowGeneration(input) { generation = { ...generation, candidate: input.definition, stateVersion: generation.stateVersion + 1 }; return { generation } }
export async function cancelWorkflowGeneration() { generation = { ...generation, status: 'cancelled' }; return { generation } }
export async function saveWorkflow(input) {
  const version = { definitionId: 'flow-1', projectId: input.projectId, revision: versions.length + 1, definition: input.definition, origin: 'nl-generated', createdAt: now() }
  versions = [version]
  drafts = [{ ...drafts[0], revision: drafts[0].revision + 1, definitionId: version.definitionId, baseVersion: version.revision }]
  return { version, draft: drafts[0] }
}
export async function validateWorkflow(input) {
  window.workflowCalls.push('validate')
  return window.validationValid ? { valid: true, issues: [], order: input.definition.nodes.map(node => node.id) } : { valid: false, issues: [{ code: 'fixture_invalid', path: 'nodes', message: '测试校验未通过' }], order: [] }
}
export async function startWorkflow(input) {
  window.workflowCalls.push('start')
  detail = { run: { id: 'run-1', projectId: input.projectId, stateVersion: 1, status: 'succeeded', attemptsUsed: 0, tokensUsed: 0, toolsUsed: 0, tokensEstimated: false, createdAt: now(), errorCode: null, snapshot: { definition: versions[0].definition } }, attempts: [], outputs: [], confirmations: [], result: null, changedFiles: [] }
  return { detail }
}
export async function archiveWorkflow() { return { archived: true } }
export async function cancelWorkflow() { return { detail } }
export async function resumeWorkflow() { return { detail } }
export async function retryWorkflowNode() { return { detail } }
export async function respondWorkflow() { return { detail } }
`

export const providerApiMock = `export async function listProviders() { return { profiles: [{ id: 'fixture', name: 'Synthetic', models: ['text'], enabled: true, capabilities: ['chat'] }] } }`
export const agentApiMock = `export async function listAgentTemplates() { return [] }`
export const transportMock = `export const transport = { onEvent: () => () => {}, request: async () => {} }; export const newRequestId = () => crypto.randomUUID()`
