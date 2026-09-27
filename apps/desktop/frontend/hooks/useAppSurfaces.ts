import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type {
  AgentTemplate,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { listSkills } from '../api/skills'
import { listAgentTemplates } from '../api/agents'
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
): AgentTemplate[] {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  useEffect(() => {
    if (!runtimeReady) return
    listAgentTemplates()
      .then(setTemplates)
      .catch(() => {})
  }, [refreshKey, runtimeReady])
  return templates
}

export function useSkillCatalog(runtimeReady: boolean): SkillManifest[] {
  const [skills, setSkills] = useState<SkillManifest[]>([])
  useEffect(() => {
    if (!runtimeReady) return
    listSkills()
      .then((result) => setSkills(result.skills))
      .catch(() => {})
  }, [runtimeReady])
  return skills
}
