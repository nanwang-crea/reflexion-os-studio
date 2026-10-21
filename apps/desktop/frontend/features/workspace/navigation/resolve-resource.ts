import type { Project, ResourceLink } from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import { listDir } from '../../../api/workspace'

type FileLink = Extract<ResourceLink, { kind: 'workspaceFile' }>

/** 兼容省略项目 ID 的模型链接，但只能解析到当前工作区。 */
export async function resolveWorkspaceResource(
  link: FileLink,
  projectId: string | null,
  projects: readonly Project[],
): Promise<FileLink> {
  if (projectId === null) throw new Error('资源不属于当前项目')
  if (link.projectId === '' || link.projectId === projectId)
    return { ...link, projectId }
  // 已知项目与 UUID 形状的项目引用不得重绑定到当前项目。
  if (
    projects.some((project) => project.id === link.projectId) ||
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(link.projectId) ||
    /[/\\:#?]/.test(link.projectId) ||
    link.projectId === '.' ||
    link.projectId === '..'
  )
    throw new Error('资源不属于当前项目')

  // workspace://apps/src/a.ts 把首层目录放进了 URI authority。
  // 先由现有 Rust 工作区边界确认它确实是目录，再保留该前缀打开文件。
  await listDir(projectId, link.projectId, 0, 1)
  const path = `${link.projectId}/${link.path}`
  return {
    ...link,
    projectId,
    path,
    uri: workspaceFileUri(projectId, path, link.line),
  }
}
