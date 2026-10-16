import { AgentTeamShareSchema } from '../agent-role-share.js'
import { AgentTemplateSaveParamsSchema } from './agent-template-input.js'
import { z } from 'zod'
import { AgentTemplateSchema, PermissionPresetSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

const AgentTemplateTargetsSchema = z
  .array(
    z.strictObject({
      id: z.string().min(1),
      updatedAt: z.string().min(1),
    }),
  )
  .min(1)
  .max(500)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    '角色不能重复',
  )

export const agentTemplateCommands = {
  'agent_template.team_export': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      teamId: AgentTeamShareSchema.shape.teamId,
      projectId: z.string().min(1).nullable(),
      templateIds: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
      directory: z.string().min(1),
    }),
    result: z.object({
      path: z.string(),
      roleCount: z.number().int().positive(),
    }),
  },
  'agent_template.team_import': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      archive: AgentTeamShareSchema,
      projectId: z.string().min(1).nullable(),
    }),
    result: z.object({
      templates: z.array(AgentTemplateSchema),
      teamId: z.string(),
    }),
  },
  'agent_template.package_preview': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      data: z.string().max(48 * 1024 * 1024),
      projectId: z.string().nullable(),
    }),
    result: z.object({
      digest: z.string(),
      role: AgentTemplateSaveParamsSchema.omit({ requestId: true }),
      skills: z.array(
        z.object({
          id: z.string(),
          version: z.string(),
          action: z.enum(['install', 'reuse']),
        }),
      ),
    }),
  },
  'agent_template.package_import': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      data: z.string().max(48 * 1024 * 1024),
      projectId: z.string().nullable(),
      digest: z.string().length(64),
    }),
    result: z.object({ template: AgentTemplateSchema }),
  },
  'agent_template.export': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      templateId: z.string().min(1),
      includeSkills: z.boolean().optional(),
      directory: z.string().min(1),
    }),
    result: z.object({ path: z.string() }),
  },
  'agent_template.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ templates: z.array(AgentTemplateSchema) }),
  },
  'agent_template.save': {
    params: AgentTemplateSaveParamsSchema,
    result: z.object({ template: AgentTemplateSchema }),
  },
  'agent_template.bulk_update': {
    params: z
      .object({
        requestId: RequestIdSchema,
        targets: AgentTemplateTargetsSchema,
        patch: z
          .object({
            projectId: z.string().min(1).nullable().optional(),
            permissionCeiling: PermissionPresetSchema.optional(),
            allowedTools: z.array(z.string().min(1)).optional(),
            canDelegate: z.boolean().optional(),
            enabled: z.boolean().optional(),
          })
          .strict()
          .refine((patch) => Object.keys(patch).length > 0, '请选择修改项'),
      })
      .strict(),
    result: z.object({ templates: z.array(AgentTemplateSchema) }),
  },
  'agent_template.bulk_remove': {
    params: z.strictObject({
      requestId: RequestIdSchema,
      targets: AgentTemplateTargetsSchema,
    }),
    result: z.object({ removedIds: z.array(z.string()) }),
  },
  'agent_template.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      templateId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
}

export type AgentTemplateSaveParams = z.input<
  (typeof agentTemplateCommands)['agent_template.save']['params']
>

export type AgentTemplateBulkUpdateParams = z.input<
  (typeof agentTemplateCommands)['agent_template.bulk_update']['params']
>

export type AgentTeamExportParams = z.input<
  (typeof agentTemplateCommands)['agent_template.team_export']['params']
>

export type AgentRolePackagePreview = z.infer<
  (typeof agentTemplateCommands)['agent_template.package_preview']['result']
>

export type AgentTemplateBulkRemoveParams = z.input<
  (typeof agentTemplateCommands)['agent_template.bulk_remove']['params']
>
