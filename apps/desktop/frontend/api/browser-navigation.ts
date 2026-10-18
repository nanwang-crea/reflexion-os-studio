import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { transport } from '../lib/transport'

type Completion = Extract<RuntimeEvent, { type: 'tool.completed' }>
export type BrowserNavigationCompletion = Completion & {
  navigation: NonNullable<Completion['navigation']>
}
export function subscribeBrowserNavigation(
  listener: (event: BrowserNavigationCompletion) => void,
): () => void {
  return transport.onEvent((event) => {
    if (event.type === 'tool.completed' && event.navigation)
      listener(event as BrowserNavigationCompletion)
  })
}
