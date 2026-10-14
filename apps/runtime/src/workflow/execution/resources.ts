import { assertWorkflowValuesSafe } from '../security/content.js'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  WorkflowValuesSchema,
  FileRevisionSchema,
  type WorkflowValues,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { SystemRuntimeClient } from '../../system.js'
import { assertRelativePath } from '../../workspace/shared.js'
import { touchesSensitive } from '../../agent/permissions/escalation.js'
import type { AssetService } from '../../assets/service.js'
import { canonicalJson } from '../graph/json-schema.js'

export function workflowHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** No credential paths are opened; actual filesystem containment is enforced by Rust. */
export async function validateWorkflowResources(
  deps: {
    store: Store
    system: SystemRuntimeClient | null
    assets: AssetService
  },
  projectId: string,
  values: WorkflowValues,
  signal?: AbortSignal,
): Promise<void> {
  WorkflowValuesSchema.parse(values)
  assertWorkflowValuesSafe(values)
  for (const item of Object.values(values)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (item.type !== 'resource') continue
    const resource = item.value
    if (resource.kind === 'asset') {
      const asset = deps.store.assetStore.get(resource.assetId)
      if (
        !asset ||
        asset.projectId !== projectId ||
        asset.hash !== resource.hash ||
        asset.preview !== 'ready'
      )
        throw new Error('workflow_resource_stale')
      if (!(await deps.assets.verifyHash(asset)))
        throw new Error('workflow_resource_stale')
    } else {
      const root = deps.store.projects.get(projectId)?.folderPath
      const path = assertRelativePath(resource.path)
      if (
        !root ||
        resource.projectId !== projectId ||
        // Portable resource identities exclude Windows streams, device aliases,
        // and names normalized by Win32 before the filesystem boundary sees them.
        /[<>:"|?*\x00-\x1f\x7f]/.test(path) ||
        path
          .split('/')
          .some(
            (part) =>
              (part !== '.' && /[. ]$/.test(part)) ||
              /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(
                part,
              ),
          ) ||
        touchesSensitive(resolve(root, path))
      )
        throw new Error('workflow_resource_denied')
      if (!deps.system?.available)
        throw new Error('workflow_resource_unavailable')
      const result = (await deps.system.request(
        'file.read',
        { workspaceRoot: root, path, limit: 1 },
        { signal },
      )) as { revision?: unknown }
      const revision = FileRevisionSchema.parse(result.revision)
      if (canonicalJson(revision) !== canonicalJson(resource.revision))
        throw new Error('workflow_resource_stale')
    }
  }
}
