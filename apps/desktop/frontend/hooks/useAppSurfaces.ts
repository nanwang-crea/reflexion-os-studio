import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
} from 'react'
import type {
  AgentTemplate,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { listSkills } from '../api/skills'
import { listAgentTemplates } from '../api/agents'
import { transport } from '../lib/transport'
import { terminalManager } from '../features/terminal/manager'

export function useTerminalSurface(activeProjectId: string | null): {
  terminalOpen: boolean
  toggleTerminal: () => void
} {
  const terminalOpen = useSyncExternalStore(
    terminalManager.subscribe,
    terminalManager.selectPanelOpen,
  )
  useEffect(() => terminalManager.init(), [])
  useEffect(() => {
    terminalManager.setActiveProject(activeProjectId)
  }, [activeProjectId])
  const toggleTerminal = useCallback(() => terminalManager.togglePanel(), [])
  return { terminalOpen, toggleTerminal }
}

export function useAgentTemplateCatalog(
  runtimeReady: boolean,
  refreshKey: string,
  projectId: string | null,
): AgentTemplate[] {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  useEffect(() => {
    if (!runtimeReady) return
    let active = true
    setTemplates([])
    listAgentTemplates(projectId)
      .then((templates) => {
        if (active) setTemplates(templates)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [projectId, refreshKey, runtimeReady])
  return templates
}

export function useSkillCatalog(
  runtimeReady: boolean,
  activeProjectId: string | null,
): SkillManifest[] {
  const [skills, setSkills] = useState<SkillManifest[]>([])
  const request = useRef(0)
  const reload = useCallback(async () => {
    if (!runtimeReady) return
    const epoch = ++request.current
    const result = await listSkills(activeProjectId)
    if (epoch === request.current) setSkills(result.skills)
  }, [activeProjectId, runtimeReady])
  const latest = useRef(reload)
  latest.current = reload
  const invalidate = useCallback(() => {
    request.current++
  }, [])
  useEffect(() => {
    void reload().catch(() => {})
    return invalidate
  }, [reload, invalidate])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = transport.onEvent((event) => {
      if (event.type !== 'plugin.changed') return
      timer ??= setTimeout(() => {
        timer = undefined
        void latest.current().catch(() => {})
      }, 32)
    })
    return () => {
      dispose()
      clearTimeout(timer)
    }
  }, [])
  return skills
}
