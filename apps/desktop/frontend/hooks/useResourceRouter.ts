import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { openExternalUrl } from '../api/system'
import type { WorkspaceOpenRequest } from '../features/workspace/types'

interface ResourceRouterOptions {
  activeProjectRef: RefObject<string | null>
  setWorkspaceRequest: (request: WorkspaceOpenRequest) => void
  setWorkspaceOpen: (open: boolean) => void
  setNotice: (notice: string | null) => void
}

export function useResourceRouter(
  options: ResourceRouterOptions,
): (link: ResourceLink) => void {
  // 依赖拆到成员级：options 对象字面量每次渲染都是新身份，会让回调
  // 随宿主每帧重渲染而抖动，击穿下游 memo（AGENTS §10）。四个成员
  // （ref + setState setters）身份恒定，回调因此全程稳定。
  const { activeProjectRef, setWorkspaceRequest, setWorkspaceOpen, setNotice } =
    options
  return useCallback(
    (link: ResourceLink): void => {
      if (link.kind === 'externalUrl') {
        void openExternalUrl(link.uri).catch((error: unknown) =>
          setNotice(
            `打开链接失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        return
      }
      const activeProjectId = activeProjectRef.current
      if (link.kind === 'workspaceFile') {
        const projectId =
          link.projectId === '' ? activeProjectId : link.projectId
        if (projectId === null || projectId !== activeProjectId) {
          setNotice('资源不属于当前项目')
          return
        }
        setWorkspaceRequest({
          nonce: Date.now(),
          kind: 'file',
          path: link.path,
          line: link.line,
        })
      } else {
        setWorkspaceRequest({
          nonce: Date.now(),
          kind: 'asset',
          assetId: link.assetId,
        })
      }
      setWorkspaceOpen(true)
    },
    [activeProjectRef, setWorkspaceRequest, setWorkspaceOpen, setNotice],
  )
}
