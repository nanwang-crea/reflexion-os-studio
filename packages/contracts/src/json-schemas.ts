import { z } from 'zod'
import { CommandSchemaRegistry } from './commands.js'
import {
  MemorySchema,
  MessageSchema,
  ProjectSchema,
  ProviderProfileSchema,
  RunSchema,
  SessionSchema,
  SkillManifestSchema,
  ToolCallSchema,
  ToolSpecSchema,
  WorkspaceEntrySchema,
  WorkspaceIndexSnapshotSchema,
  WorkspaceReadResultSchema,
  ChangedFileSchema,
  FileWriteResultSchema,
  FileEditResultSchema,
  FileDeleteResultSchema,
  FileMoveResultSchema,
  FileMkdirResultSchema,
  GitChangeEntrySchema,
  AssetRefSchema,
  ResourceLinkSchema,
  ArtifactSchema,
  QueueEntrySchema,
  AgentSettingsSchema,
  McpServerSchema,
  McpToolSchema,
} from './entities.js'
import { RuntimeErrorSchema } from './errors.js'
import { JsonRpcMessageSchema } from './jsonrpc.js'
import { RuntimeEventSchema } from './events.js'

function toJSONSchema(name: string, schema: z.ZodType): [string, unknown] {
  return [name, z.toJSONSchema(schema)]
}

export const jsonSchemas: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries([
    toJSONSchema('JsonRpcMessage', JsonRpcMessageSchema),
    toJSONSchema('Project', ProjectSchema),
    toJSONSchema('Session', SessionSchema),
    toJSONSchema('Message', MessageSchema),
    toJSONSchema('Run', RunSchema),
    toJSONSchema('ToolCall', ToolCallSchema),
    toJSONSchema('ToolSpec', ToolSpecSchema),
    toJSONSchema('SkillManifest', SkillManifestSchema),
    toJSONSchema('Memory', MemorySchema),
    toJSONSchema('ProviderProfile', ProviderProfileSchema),
    toJSONSchema('WorkspaceEntry', WorkspaceEntrySchema),
    toJSONSchema('WorkspaceIndexSnapshot', WorkspaceIndexSnapshotSchema),
    toJSONSchema('WorkspaceReadResult', WorkspaceReadResultSchema),
    toJSONSchema('ChangedFile', ChangedFileSchema),
    toJSONSchema('FileWriteResult', FileWriteResultSchema),
    toJSONSchema('FileEditResult', FileEditResultSchema),
    toJSONSchema('FileDeleteResult', FileDeleteResultSchema),
    toJSONSchema('FileMoveResult', FileMoveResultSchema),
    toJSONSchema('FileMkdirResult', FileMkdirResultSchema),
    toJSONSchema('GitChangeEntry', GitChangeEntrySchema),
    toJSONSchema('AssetRef', AssetRefSchema),
    toJSONSchema('ResourceLink', ResourceLinkSchema),
    toJSONSchema('Artifact', ArtifactSchema),
    toJSONSchema('QueueEntry', QueueEntrySchema),
    toJSONSchema('AgentSettings', AgentSettingsSchema),
    toJSONSchema('McpServer', McpServerSchema),
    toJSONSchema('McpTool', McpToolSchema),
    toJSONSchema('RuntimeError', RuntimeErrorSchema),
    toJSONSchema('RuntimeEvent', RuntimeEventSchema),
    ...Object.entries(CommandSchemaRegistry).flatMap(([method, entry]) => [
      toJSONSchema(`${method}.params`, entry.params),
      toJSONSchema(`${method}.result`, entry.result),
    ]),
  ]),
)
