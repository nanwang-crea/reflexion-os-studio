import type {
  PluginInstallSource,
  PluginRecord,
  PluginTask,
  RuntimeEvent,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'
import { transport } from '../lib/transport'

/** 内置 Skill 清单：斜杠命令浮层的数据源（Phase 1A 列表即全部可用项）。 */
export function listSkills(): Promise<{ skills: SkillManifest[] }> {
  return requestList<{ skills: SkillManifest[] }>('skill.list')
}

export function listPlugins(): Promise<{ plugins: PluginRecord[] }> {
  return requestList<{ plugins: PluginRecord[] }>('plugin.list')
}

export function previewPlugin(source: PluginInstallSource): Promise<{
  task: PluginTask
}> {
  return request('plugin.preview', source)
}

export function installPlugin(
  source: PluginInstallSource,
): Promise<{ task: PluginTask }> {
  return request('plugin.install', source)
}

export function updatePlugin(id: string): Promise<{ task: PluginTask }> {
  return request('plugin.update', { id })
}

export function listPluginTasks(): Promise<{ tasks: PluginTask[] }> {
  return requestList('plugin.task.list')
}

export function cancelPluginTask(
  taskId: string,
): Promise<{ task: PluginTask }> {
  return request('plugin.task.cancel', { taskId })
}

export function onPluginTaskChanged(
  listener: (task: PluginTask) => void,
): () => void {
  return transport.onEvent((event: RuntimeEvent) => {
    if (event.type === 'plugin.task.changed') listener(event.task)
  })
}

export function togglePlugin(
  id: string,
  enabled: boolean,
): Promise<{ plugin: PluginRecord }> {
  return request('plugin.toggle', { id, enabled })
}

export function uninstallPlugin(id: string): Promise<{ removed: boolean }> {
  return request('plugin.uninstall', { id })
}

export function rescanPlugins(): Promise<{ plugins: PluginRecord[] }> {
  return request('plugin.rescan')
}
