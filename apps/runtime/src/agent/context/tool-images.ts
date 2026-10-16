import {
  ImageMimeTypeSchema,
  type ImagePart,
  type ToolOutput,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'

/** Images are projected from canonical links and owned metadata, never private tool JSON. */
export function toolImageParts(
  store: Store,
  sessionId: string,
  runId: string,
  toolName: string,
  output: ToolOutput,
): ImagePart[] {
  if (
    toolName !== 'browser.execute' ||
    output.provenance?.kind !== 'web' ||
    output.provenance?.trust !== 'untrusted_external'
  )
    return []
  return output.resourceLinks
    .flatMap((link) => {
      if (link.kind !== 'asset') return []
      const asset = store.assetStore.get(link.assetId)
      const mime = ImageMimeTypeSchema.safeParse(asset?.mimeType)
      if (
        !asset ||
        asset.sessionId !== sessionId ||
        asset.runId !== runId ||
        asset.createdBy !== 'agent' ||
        asset.metadata.type !== 'browser-screenshot' ||
        asset.preview !== 'ready' ||
        !mime.success
      )
        return []
      return [
        { type: 'image' as const, assetId: asset.assetId, mimeType: mime.data },
      ]
    })
    .slice(-4)
}
