import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SkillManifest } from '@reflexion-os-studio/runtime-client'
import { listSkills } from '../api/skills'
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
