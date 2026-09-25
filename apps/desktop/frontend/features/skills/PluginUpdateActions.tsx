import type {
  PluginRecord,
  PluginTask,
} from '@reflexion-os-studio/runtime-client'
import { updatePlugin } from '../../api/skills'

interface PluginUpdateActionsProps {
  plugin: PluginRecord
  busy: boolean
  task: PluginTask | undefined
  remember: (task: PluginTask) => void
  cancel: (taskId: string) => Promise<void>
  onError: (message: string) => void
}

export function PluginUpdateActions(
  props: PluginUpdateActionsProps,
): React.JSX.Element {
  const { busy, cancel, onError, plugin, remember, task } = props
  const start = async (): Promise<void> => {
    try {
      const result = await updatePlugin(plugin.id)
      remember(result.task)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <>
      <button
        className="ghost"
        type="button"
        disabled={busy || task !== undefined}
        onClick={() => void start()}
      >
        {task === undefined ? '更新' : `更新中 ${task.progress}%`}
      </button>
      {task !== undefined && (
        <button
          className="ghost"
          type="button"
          onClick={() => void cancel(task.id)}
        >
          取消更新
        </button>
      )}
    </>
  )
}
