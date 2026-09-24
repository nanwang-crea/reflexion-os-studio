import type {
  PluginRecord,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

/** 内置 Skill 清单：斜杠命令浮层的数据源（Phase 1A 列表即全部可用项）。 */
export function listSkills(): Promise<{ skills: SkillManifest[] }> {
  return requestList<{ skills: SkillManifest[] }>('skill.list')
}

export function listPlugins(): Promise<{ plugins: PluginRecord[] }> {
  return requestList<{ plugins: PluginRecord[] }>('plugin.list')
}

export function installPluginFromWorkspace(
  projectId: string,
  path: string,
): Promise<{ plugin: PluginRecord }> {
  return request('plugin.install', { source: 'dir', projectId, path })
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
