import { z } from 'zod'
import { SemVerSchema } from './semver.js'

const PluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
const RelativeEntrySchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]+/).includes('..'),
    'entry must be a package-relative path',
  )

export const SkillManifestSchema = z
  .object({
    id: PluginIdSchema,
    name: z.string().min(1),
    version: SemVerSchema,
    description: z.string().min(1),
    tools: z.array(z.string().min(1)),
    argumentHint: z.string().min(1).nullable(),
  })
  .strict()
export type SkillManifest = z.infer<typeof SkillManifestSchema>

export const PluginKindSchema = z.enum(['skill', 'provider', 'tool'])
export type PluginKind = z.infer<typeof PluginKindSchema>

export const PluginStatusSchema = z.enum([
  'installed',
  'enabled',
  'disabled',
  'invalid',
])
export type PluginStatus = z.infer<typeof PluginStatusSchema>

export const PluginSourceSchema = z.enum(['builtin', 'dir', 'git', 'local'])
export type PluginSource = z.infer<typeof PluginSourceSchema>

export const PluginCompatSchema = z
  .object({
    protocol: z
      .string()
      .regex(
        /^(?:\^\d+\.\d+(?:\.\d+)?|(?:>=|>|<=|<|=)?\d+\.\d+(?:\.\d+)?)(?:\s+(?:>=|>|<=|<|=)\d+\.\d+(?:\.\d+)?)*$/,
      ),
  })
  .strict()
export type PluginCompat = z.infer<typeof PluginCompatSchema>

export const PluginPermissionsSchema = z
  .object({
    filesystem: z
      .enum(['none', 'workspace-read', 'workspace-write'])
      .default('none'),
    network: z.boolean().default(false),
    shell: z.boolean().default(false),
  })
  .strict()
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>

export const PluginCapabilitySchema = z.enum([
  'skill.instructions',
  'provider.chat',
  'provider.embedding',
  'provider.image',
  'provider.video',
  'tool.execute',
])
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>

export const PluginPackageManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: PluginIdSchema,
    name: z.string().min(1),
    version: SemVerSchema,
    description: z.string().min(1),
    type: PluginKindSchema,
    entry: RelativeEntrySchema,
    compatibility: PluginCompatSchema,
    capabilities: z.array(PluginCapabilitySchema).min(1),
    permissions: PluginPermissionsSchema,
    skill: z
      .object({
        tools: z.array(z.string().min(1)).default([]),
        argumentHint: z.string().min(1).nullable().default(null),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.type === 'skill') {
      if (manifest.entry !== 'SKILL.md') {
        context.addIssue({
          code: 'custom',
          path: ['entry'],
          message: 'skill entry must be SKILL.md',
        })
      }
      if (!manifest.capabilities.includes('skill.instructions')) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities'],
          message: 'skill plugin requires skill.instructions capability',
        })
      }
      if (manifest.skill === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['skill'],
          message: 'skill metadata is required for skill plugins',
        })
      }
    }
  })
export type PluginPackageManifest = z.infer<typeof PluginPackageManifestSchema>

export const PluginRecordSchema = z
  .object({
    id: PluginIdSchema,
    kind: PluginKindSchema,
    version: SemVerSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    source: PluginSourceSchema,
    sourceRef: z.string().nullable(),
    status: PluginStatusSchema,
    installPath: z.string().nullable(),
    enabled: z.boolean(),
    manifest: PluginPackageManifestSchema,
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type PluginRecord = z.infer<typeof PluginRecordSchema>

export const PluginInstallSourceSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('dir'),
      projectId: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
  z.object({ source: z.literal('local'), path: z.string().min(1) }).strict(),
  z.object({ source: z.literal('git'), url: z.string().url() }).strict(),
])
export type PluginInstallSource = z.infer<typeof PluginInstallSourceSchema>

export const PluginTaskActionSchema = z.enum(['preview', 'install', 'update'])
export type PluginTaskAction = z.infer<typeof PluginTaskActionSchema>

export const PluginTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type PluginTaskStatus = z.infer<typeof PluginTaskStatusSchema>

export const PluginTaskPhaseSchema = z.enum([
  'queued',
  'resolving',
  'downloading',
  'validating',
  'staging',
  'committing',
  'reloading',
  'completed',
])
export type PluginTaskPhase = z.infer<typeof PluginTaskPhaseSchema>

export const PluginTaskSchema = z
  .object({
    id: z.string().uuid(),
    action: PluginTaskActionSchema,
    status: PluginTaskStatusSchema,
    phase: PluginTaskPhaseSchema,
    progress: z.number().int().min(0).max(100),
    pluginId: PluginIdSchema.nullable(),
    manifest: PluginPackageManifestSchema.nullable(),
    installed: PluginRecordSchema.nullable(),
    plugin: PluginRecordSchema.nullable(),
    warnings: z.array(z.string()),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type PluginTask = z.infer<typeof PluginTaskSchema>

export function skillManifestFromPackage(
  manifest: PluginPackageManifest,
): SkillManifest {
  if (manifest.type !== 'skill' || manifest.skill === undefined) {
    throw new Error('plugin is not a skill package')
  }
  return SkillManifestSchema.parse({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    tools: manifest.skill.tools,
    argumentHint: manifest.skill.argumentHint,
  })
}
