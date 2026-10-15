import type { StreamedToolCall } from '../../provider/types.js'
import type { RunEventEmitter } from '../../events.js'
import { containsSecretLike } from '../instructions/secretGuard.js'

/** Publish display metadata only, once per changed call label, never argument text. */
export function createModelActivityReporter(
  emitter: RunEventEmitter,
  messageId: string,
) {
  const labels = new Map<
    string,
    { label: string; arguments: string; name: string }
  >()
  return {
    reset: () => labels.clear(),
    report: (call: StreamedToolCall): void => {
      const previous = labels.get(call.id)
      if (previous?.arguments === call.arguments && previous.name === call.name)
        return
      let taskName: string | undefined
      if (call.name === 'task' && call.arguments.trimEnd().endsWith('}')) {
        try {
          const parsed: unknown = JSON.parse(call.arguments)
          if (
            parsed &&
            typeof parsed === 'object' &&
            'name' in parsed &&
            typeof parsed.name === 'string'
          ) {
            const name = parsed.name.trim()
            if (name && name.length <= 80 && !containsSecretLike(name))
              taskName = name
          }
        } catch {
          /* Partial JSON is progress, never a callable task. */
        }
      }
      const label = JSON.stringify([call.name, taskName])
      labels.set(call.id, {
        label,
        arguments: call.arguments,
        name: call.name,
      })
      if (previous?.label === label) return
      emitter.next({
        type: 'run.model_activity',
        messageId,
        phase: 'preparing_tool',
        toolName: call.name.slice(0, 200),
        ...(taskName ? { taskName } : {}),
      })
    },
  }
}
