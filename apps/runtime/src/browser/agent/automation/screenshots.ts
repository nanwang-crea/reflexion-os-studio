import type { ToolContext } from '../../../agent/tools/shared.js'
import {
  BrowserExecutionResultSchema,
  type ResourceLink,
} from '@reflexion-os-studio/contracts'
import { AssetService } from '../../../assets/service.js'
import { uploadImageAsset } from '../../../assets/images/upload.js'

/** Strip worker image bytes before ToolOutput/events/history persistence. */
export async function saveBrowserScreenshots(
  ctx: ToolContext,
  raw: unknown,
  signal: AbortSignal,
) {
  const result = BrowserExecutionResultSchema.parse(raw)
  const screenshots = []
  const resourceLinks: ResourceLink[] = []
  try {
    for (const screenshot of result.screenshots) {
      signal.throwIfAborted()
      const asset = await uploadImageAsset(
        ctx.store,
        ctx.store.dataDir,
        {
          sessionId: ctx.sessionId,
          fileName: `browser-${ctx.runId}-${screenshot.step}.jpg`,
          mimeType: screenshot.image.mimeType,
          base64: screenshot.image.base64,
        },
        {
          runId: ctx.runId,
          metadata: {
            type: 'browser-screenshot',
            step: screenshot.step,
            page: screenshot.page,
            sourceUrl: screenshot.sourceUrl,
          },
        },
      )
      resourceLinks.push({
        kind: 'asset',
        uri: asset.uri,
        assetId: asset.assetId,
      })
      screenshots.push({
        step: screenshot.step,
        page: screenshot.page,
        sourceUrl: screenshot.sourceUrl,
        assetId: asset.assetId,
        uri: asset.uri,
        mimeType: asset.mimeType,
      })
    }
  } catch (error) {
    const assets = new AssetService(ctx.store, ctx.store.dataDir)
    await Promise.allSettled(
      resourceLinks.map((link) =>
        link.kind === 'asset'
          ? assets.delete(link.assetId)
          : Promise.resolve(false),
      ),
    )
    throw error
  }
  return { data: { ...result, screenshots }, resourceLinks }
}
