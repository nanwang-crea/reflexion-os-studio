import type { Project } from '@reflexion-os-studio/runtime-client'
import { request, requestList } from './client'

export function listProjects(): Promise<{ projects: Project[] }> {
  return requestList<{ projects: Project[] }>('project.list')
}

export function createProject(folderPath: string): Promise<{
  project: Project
}> {
  return request<{ project: Project }>('project.create', { folderPath })
}

export function deleteProject(projectId: string): Promise<{
  removed: boolean
}> {
  return request<{ removed: boolean }>('project.delete', { projectId })
}
