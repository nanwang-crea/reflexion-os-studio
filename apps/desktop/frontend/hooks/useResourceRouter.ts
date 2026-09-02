import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { openExternalUrl } from '../api/system'
import type { WorkspaceOpenRequest } from '../features/workspace/WorkspacePanel'

interface ResourceRouterOptions {
  activeProjectRef: RefObject<string | null>
  setWorkspaceRequest: (request: WorkspaceOpenRequest) => void
  setWorkspaceOpen: (open: boolean) => void
  setNotice: (notice: string | null) => void
}

export function useResourceRouter(
  options: ResourceRouterOptions,
): (link: ResourceLink) => void {
  return useCallback(
    (link: ResourceLink): void => {
      if (link.kind === 'externalUrl') {
        void openExternalUrl(link.uri).catch((error: unknown) =>
          options.setNotice(
            `打开链接失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        return
      }
      const activeProjectId = options.activeProjectRef.current
      if (link.kind === 'workspaceFile') {
        const projectId =
          link.projectId === '' ? activeProjectId : link.projectId
        if (projectId === null || projectId !== activeProjectId) {
          options.setNotice('资源不属于当前项目')
          return
        }
        options.setWorkspaceRequest({
          nonce: Date.now(),
          kind: 'file',
          path: link.path,
          line: link.line,
        })
      } else {
        options.setWorkspaceRequest({
          nonce: Date.now(),
          kind: 'asset',
          assetId: link.assetId,
        })
      }
      options.setWorkspaceOpen(true)
    },
    [options],
  )
}
