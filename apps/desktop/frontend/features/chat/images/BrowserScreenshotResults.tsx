import type { ToolCall } from '@reflexion-os-studio/runtime-client'
import { MessageImage } from './MessageImage'

export function BrowserScreenshotResults({
  call,
}: {
  call: ToolCall
}): React.JSX.Element | null {
  if (
    call.toolName !== 'browser.execute' ||
    call.output?.provenance?.kind !== 'web'
  )
    return null
  const links = call.output.resourceLinks
    .filter((link) => link.kind === 'asset')
    .slice(0, 4)
  if (!links.length) return null
  return (
    <div className="message-images" aria-label="浏览器截图">
      {links.map((link) => (
        <MessageImage
          key={link.assetId}
          assetId={link.assetId}
          expectedRunId={call.runId}
        />
      ))}
    </div>
  )
}
