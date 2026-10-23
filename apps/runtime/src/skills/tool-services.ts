import type {
  PluginRecord,
  SkillPrepared,
  SkillResourceReadOptions,
  SkillSaveParams,
} from '@reflexion-os-studio/contracts'

/** Capability injection keeps agent execution independent of plugin lifecycle ownership. */
export interface SkillToolServices {
  save(input: SkillSaveParams): Promise<PluginRecord>
  prepare(
    skillId: string,
    projectId: string | null,
    runId: string,
    resource?: string,
    options?: SkillResourceReadOptions,
  ): SkillPrepared
  releaseRun(runId: string): void
}
