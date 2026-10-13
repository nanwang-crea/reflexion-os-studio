import { z } from 'zod'
import { AgentPolicySchema } from '../entities/agents.js'
import {
  WorkflowDefinitionInputSchema,
  WorkflowEndpointSchema,
  WorkflowPortSchema,
  WorkflowValueSchema,
} from './values.js'

export const WorkflowBudgetSchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(128),
  maxParallel: z.number().int().min(1).max(8),
  maxTokens: z.number().int().min(1000).max(10_000_000),
  maxToolCalls: z.number().int().min(1).max(4096),
  maxExecutionSec: z.number().int().min(10).max(86400),
  confirmationExpirySec: z.number().int().min(60).max(604800),
})
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>

export const WorkflowModelBindingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('default') }),
  z.strictObject({
    mode: z.literal('explicit'),
    providerId: z.string().min(1),
    model: z.string().min(1).max(200),
  }),
])
export type WorkflowModelBinding = z.infer<typeof WorkflowModelBindingSchema>

export const WorkflowRoleSnapshotSchema = z.strictObject({
  templateId: z.string().min(1).nullable(),
  templateUpdatedAt: z.iso.datetime().nullable(),
  name: z.string().min(1).max(120),
  systemPrompt: z.string().min(1).max(20_000),
  policy: AgentPolicySchema.extend({ canDelegate: z.literal(false) }).strict(),
})
export type WorkflowRoleSnapshot = z.infer<typeof WorkflowRoleSnapshotSchema>

const NodeBase = {
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  inputs: z.array(WorkflowPortSchema).max(32),
  outputs: z.array(WorkflowPortSchema).min(1).max(32),
}
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...NodeBase,
    kind: z.literal('agent'),
    role: WorkflowRoleSnapshotSchema,
    taskPrompt: z.string().min(1).max(20_000),
    model: WorkflowModelBindingSchema,
    budget: z.strictObject({
      maxTokens: z.number().int().min(1000).max(1_000_000),
      maxToolCalls: z.number().int().min(1).max(4096),
      maxExecutionSec: z.number().int().min(10).max(7200),
    }),
  }),
  z.strictObject({
    ...NodeBase,
    kind: z.literal('confirmation'),
    instruction: z.string().min(1).max(2000),
  }),
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowAgentNode = Extract<WorkflowNode, { kind: 'agent' }>

export const WorkflowEdgeSchema = z.strictObject({
  from: WorkflowEndpointSchema,
  to: WorkflowEndpointSchema,
})
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>

/** Flow inputs and constants are bindings, never executable nodes. */
export const WorkflowBindingSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('input'),
    inputKey: z.string().min(1).max(64),
    to: WorkflowEndpointSchema,
  }),
  z.strictObject({
    source: z.literal('constant'),
    value: WorkflowValueSchema,
    to: WorkflowEndpointSchema,
  }),
])
export const WorkflowDefinitionSchema = WorkflowDefinitionInputSchema.pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    inputs: z.array(WorkflowPortSchema).max(32),
    outputs: z
      .array(
        z.strictObject({
          port: WorkflowPortSchema,
          from: WorkflowEndpointSchema,
        }),
      )
      .min(1)
      .max(32),
    nodes: z.array(WorkflowNodeSchema).min(1).max(64),
    edges: z.array(WorkflowEdgeSchema).max(512),
    bindings: z.array(WorkflowBindingSchema).max(512),
    budget: WorkflowBudgetSchema,
    layout: z
      .array(
        z.strictObject({
          nodeId: z.string().min(1).max(80),
          x: z.number().min(-100000).max(100000),
          y: z.number().min(-100000).max(100000),
        }),
      )
      .max(64),
  }),
)
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

export const WorkflowVersionSchema = z.strictObject({
  definitionId: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  definition: WorkflowDefinitionSchema,
  origin: z.enum(['manual', 'nl-generated']),
  createdAt: z.iso.datetime(),
})
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>
