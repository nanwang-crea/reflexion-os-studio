import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import type { Project, ResourceLink } from '@reflexion-os-studio/runtime-client'
import { setBrowserPanelOpen } from '../features/browser/panel-state'
import { openBrowserUrl } from '../api/browser'
import { resolveWorkspaceResource } from '../features/workspace/navigation/resolve-resource'
import type { WorkspaceOpenRequest } from '../features/workspace/types'

interface ResourceRouterOptions {
  activeProjectRef: RefObject<string | null>
  projects: readonly Project[]
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
  const projectsRef = useRef(options.projects)
  projectsRef.current = options.projects
  const requestRef = useRef(0)
  return useCallback(
    (link: ResourceLink): void => {
      const request = ++requestRef.current
      if (link.kind === 'externalUrl') {
        void openBrowserUrl(link.uri).catch((error: unknown) =>
          setNotice(
            `打开链接失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        return
      }
      const activeProjectId = activeProjectRef.current
      if (link.kind === 'workspaceFile') {
        void resolveWorkspaceResource(
          link,
          activeProjectId,
          projectsRef.current,
        )
          .then((resolved) => {
            if (
              request !== requestRef.current ||
              activeProjectRef.current !== activeProjectId
            )
              return
            setWorkspaceRequest({
              nonce: request,
              kind: 'file',
              projectId: resolved.projectId,
              path: resolved.path,
              line: resolved.line,
            })
          })
          .catch((error: unknown) => {
            if (
              request !== requestRef.current ||
              activeProjectRef.current !== activeProjectId
            )
              return
            setNotice(
              error instanceof Error ? error.message : '打开文件链接失败',
            )
          })
        return
      } else {
        setWorkspaceRequest({
          nonce: request,
          kind: 'asset',
          assetId: link.assetId,
        })
      }
      setBrowserPanelOpen(false)
      setWorkspaceOpen(true)
    },
    [activeProjectRef, setWorkspaceRequest, setWorkspaceOpen, setNotice],
  )
}
