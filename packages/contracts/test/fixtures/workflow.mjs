export function textPort(key = 'text', required = true) {
  return { key, title: key, required, type: 'text' }
}

export function agentNode(id) {
  return {
    id,
    name: id,
    kind: 'agent',
    inputs: [textPort()],
    outputs: [textPort()],
    role: {
      templateId: null,
      templateUpdatedAt: null,
      name: id,
      systemPrompt: `Complete the ${id} task.`,
      policy: {
        version: 1,
        permissionCeiling: 'workspace-read',
        allowedTools: ['file.read'],
        canDelegate: false,
      },
    },
    taskPrompt: 'Process the input and return the requested output.',
    model: { mode: 'default' },
    budget: { maxTokens: 1000, maxToolCalls: 10, maxExecutionSec: 60 },
  }
}

export function workflowFixture() {
  return {
    schemaVersion: 1,
    name: 'Writing',
    description: 'Synthetic fixture',
    inputs: [textPort()],
    outputs: [
      { port: textPort(), from: { nodeId: 'editor', portKey: 'text' } },
    ],
    nodes: [agentNode('writer'), agentNode('editor')],
    edges: [
      {
        from: { nodeId: 'writer', portKey: 'text' },
        to: { nodeId: 'editor', portKey: 'text' },
      },
    ],
    bindings: [
      {
        source: 'input',
        inputKey: 'text',
        to: { nodeId: 'writer', portKey: 'text' },
      },
    ],
    budget: {
      maxAttempts: 8,
      maxParallel: 2,
      maxTokens: 8000,
      maxToolCalls: 40,
      maxExecutionSec: 600,
      confirmationExpirySec: 3600,
    },
    layout: [],
  }
}
