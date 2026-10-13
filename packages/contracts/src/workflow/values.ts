import { FileRevisionSchema } from '../entities/workspace/files.js'
import { z } from 'zod'
import { JsonValueSchema } from '../json-value.js'

export const WORKFLOW_VALUE_LIMITS = {
  depth: 16,
  entries: 4096,
  bytes: 256 * 1024,
} as const

export const WORKFLOW_DEFINITION_LIMITS = {
  depth: 32,
  entries: 32768,
  bytes: 2 * 1024 * 1024,
} as const

/** Bound unknown JSON before entering recursive schemas or serializing it. */
export function workflowValueWithinBounds(
  value: unknown,
  limits: {
    depth: number
    entries: number
    bytes: number
  } = WORKFLOW_VALUE_LIMITS,
): boolean {
  const pending = [{ value, depth: 0, exit: false }]
  const ancestors = new Set<object>()
  let entries = 0
  let stringBytes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (item.exit) {
      ancestors.delete(item.value as object)
      continue
    }
    if (++entries > limits.entries || item.depth > limits.depth) return false
    if (item.value !== null && typeof item.value === 'object') {
      if (ancestors.has(item.value)) return false
      ancestors.add(item.value)
      pending.push({ ...item, exit: true })
      const children = Object.values(item.value)
      if (children.length > limits.entries - entries) return false
      for (const child of children)
        pending.push({ value: child, depth: item.depth + 1, exit: false })
    } else if (typeof item.value === 'string') {
      if (item.value.length > limits.bytes) return false
      stringBytes += new TextEncoder().encode(item.value).length
      if (stringBytes > limits.bytes) return false
    } else if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) return false
    } else if (typeof item.value !== 'boolean' && item.value !== null)
      return false
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).length <= limits.bytes
    )
  } catch {
    return false
  }
}

export const WorkflowDefinitionInputSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!workflowValueWithinBounds(value, WORKFLOW_DEFINITION_LIMITS))
      ctx.addIssue({
        code: 'custom',
        message: 'workflow_definition_limit',
        fatal: true,
      })
  })

const BoundedInputSchema = z.unknown().superRefine((value, ctx) => {
  if (!workflowValueWithinBounds(value))
    ctx.addIssue({
      code: 'custom',
      message: 'workflow_value_limit',
      fatal: true,
    })
})
export const WorkflowJsonValueSchema = BoundedInputSchema.pipe(JsonValueSchema)
export type WorkflowJsonValue = z.infer<typeof WorkflowJsonValueSchema>

export const WorkflowJsonShapeSchema = z.strictObject({
  type: z.enum([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ]),
  get properties(): z.ZodOptional<
    z.ZodRecord<z.ZodString, typeof WorkflowJsonShapeSchema>
  > {
    return z
      .record(z.string().min(1).max(80), WorkflowJsonShapeSchema)
      .optional()
  },
  required: z.array(z.string().min(1).max(80)).max(64).optional(),
  additionalProperties: z.boolean().optional(),
  get items(): z.ZodOptional<typeof WorkflowJsonShapeSchema> {
    return WorkflowJsonShapeSchema.optional()
  },
  enum: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .min(1)
    .max(64)
    .optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().int().nonnegative().max(65536).optional(),
  maxLength: z.number().int().nonnegative().max(65536).optional(),
  minItems: z.number().int().nonnegative().max(1024).optional(),
  maxItems: z.number().int().nonnegative().max(1024).optional(),
})

export const WorkflowJsonSchemaSchema = BoundedInputSchema.pipe(
  WorkflowJsonShapeSchema,
)
export type WorkflowJsonSchema = z.infer<typeof WorkflowJsonSchemaSchema>

const KeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const PortBase = {
  key: KeySchema,
  title: z.string().min(1).max(120),
  required: z.boolean(),
}
export const WorkflowPortSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...PortBase, type: z.literal('text') }),
  z.strictObject({
    ...PortBase,
    type: z.literal('json'),
    schema: WorkflowJsonSchemaSchema,
  }),
  z.strictObject({
    ...PortBase,
    type: z.literal('resource'),
    resourceKind: z.enum(['workspaceFile', 'asset']),
  }),
])
export type WorkflowPort = z.infer<typeof WorkflowPortSchema>

export const WorkflowResourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workspaceFile'),
    projectId: z.string().min(1),
    path: z.string().min(1).max(4096),
    revision: FileRevisionSchema.extend({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  }),
  z.strictObject({
    kind: z.literal('asset'),
    assetId: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
])
export type WorkflowResource = z.infer<typeof WorkflowResourceSchema>

export const WorkflowValueSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(65536) }),
  z.strictObject({ type: z.literal('json'), value: WorkflowJsonValueSchema }),
  z.strictObject({
    type: z.literal('resource'),
    value: WorkflowResourceSchema,
  }),
])
export type WorkflowValue = z.infer<typeof WorkflowValueSchema>
export const WorkflowEndpointSchema = z.strictObject({
  nodeId: z.string().min(1).max(80),
  portKey: KeySchema,
})
