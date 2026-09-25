import { useCallback, useEffect, useState } from 'react'
import type { PluginTask } from '@reflexion-os-studio/runtime-client'
import {
  cancelPluginTask,
  listPluginTasks,
  onPluginTaskChanged,
} from '../../api/skills'

export function usePluginTasks(
  onCompleted: () => Promise<void>,
  onError: (message: string) => void,
): {
  tasks: Record<string, PluginTask>
  remember: (task: PluginTask) => void
  cancel: (taskId: string) => Promise<void>
} {
  const [tasks, setTasks] = useState<Record<string, PluginTask>>({})
  const remember = useCallback((task: PluginTask): void => {
    setTasks((current) => {
      const existing = current[task.id]
      if (
        existing !== undefined &&
        (existing.updatedAt > task.updatedAt ||
          (existing.updatedAt === task.updatedAt &&
            existing.progress > task.progress) ||
          (isTerminal(existing) && !isTerminal(task)))
      ) {
        return current
      }
      return { ...current, [task.id]: task }
    })
  }, [])

  useEffect(() => {
    let disposed = false
    void listPluginTasks().then(({ tasks: initial }) => {
      if (!disposed) {
        setTasks(Object.fromEntries(initial.map((task) => [task.id, task])))
      }
    })
    const stop = onPluginTaskChanged((task) => {
      if (disposed) return
      remember(task)
      if (task.status === 'completed' && task.action !== 'preview') {
        void onCompleted()
      }
      if (task.status === 'failed') onError(task.error ?? '插件任务失败')
    })
    return () => {
      disposed = true
      stop()
    }
  }, [onCompleted, onError, remember])

  const cancel = useCallback(
    async (taskId: string): Promise<void> => {
      const { task } = await cancelPluginTask(taskId)
      remember(task)
    },
    [remember],
  )

  return { tasks, remember, cancel }
}

function isTerminal(task: PluginTask): boolean {
  return ['completed', 'failed', 'cancelled'].includes(task.status)
}
