// Public entity facade; schemas live with their owning domain.
import { ResourceLinkSchema, type ResourceLink } from './resource-links.js'
import { JsonValueSchema, type JsonValue } from './json-value.js'
export {
  PluginCapabilitySchema,
  PluginCompatSchema,
  PluginInstallSourceSchema,
  PluginKindSchema,
  PluginPackageManifestSchema,
  PluginPermissionsSchema,
  PluginRecordSchema,
  PluginSourceSchema,
  PluginStatusSchema,
  SkillManifestSchema,
  skillManifestFromPackage,
} from './plugins.js'
export type {
  PluginCapability,
  PluginCompat,
  PluginInstallSource,
  PluginKind,
  PluginPackageManifest,
  PluginPermissions,
  PluginRecord,
  PluginSource,
  PluginStatus,
  SkillManifest,
} from './plugins.js'

export { ResourceLinkSchema }
export type { ResourceLink }
export { JsonValueSchema }
export type { JsonValue }
export {
  ChangedFileActionSchema,
  ChangedFileSchema,
  ToolOutputSchema,
  ToolProvenanceSchema,
  coerceToolOutput,
} from './tool-output.js'
export type {
  ChangedFile,
  ChangedFileAction,
  ToolOutput,
  ToolProvenance,
} from './tool-output.js'

export * from './entities/shared.js'
export * from './entities/chat/messages.js'
export * from './entities/chat/sessions.js'
export * from './entities/chat/runs.js'
export * from './entities/chat/plans.js'
export * from './entities/agents.js'
export * from './entities/tools/calls.js'
export * from './entities/tools/permissions.js'
export * from './entities/integrations/providers.js'
export * from './entities/workspace/files.js'
export * from './entities/workspace/git.js'
export * from './entities/workspace/assets.js'
export * from './entities/integrations/mcp.js'
export * from './entities/workspace/terminal.js'
