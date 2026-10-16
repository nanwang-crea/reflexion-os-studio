import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  AgentRolePackageSchema,
  type AgentTemplateSaveParams,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../../store/index.js'
import type { SkillPluginService } from '../../../skills/service.js'
import {
  inspectPackage,
  isSupportedPluginRootEntry,
} from '../../../plugins/package.js'
import { touchesSensitive } from '../../permissions/escalation.js'
import { containsSecretLike } from '../../instructions/secretGuard.js'
import { portableRole } from '../share.js'
import { validateRoleTemplate } from '../validation.js'
import { resolveRoleSkills } from '../skills.js'
import {
  contentDigest,
  decodeArchive,
  encodeArchive,
  packageFiles,
} from './archive.js'

export async function exportRolePackage(
  store: Store,
  plugins: SkillPluginService,
  templateId: string,
  directory: string,
) {
  const template = store.agents.get(templateId)
  if (!template) throw new Error('角色不存在')
  resolveRoleSkills(
    { ...template, allowedTools: template.policy.allowedTools },
    plugins.registry,
  )
  if (!isAbsolute(directory) || touchesSensitive(directory))
    throw new Error('请选择普通目录')
  const target = await realpath(directory)
  if (touchesSensitive(target)) throw new Error('请选择普通目录')
  const manifest = AgentRolePackageSchema.parse({
    format: 'reflexion-role',
    version: 1,
    role: portableRole(template),
    ...(template.modelBinding.mode === 'fixed'
      ? {
          modelPreference: {
            model: template.modelBinding.model,
            reasoningEffort: template.modelBinding.reasoningEffort ?? null,
          },
        }
      : {}),
  })
  const text = JSON.stringify(manifest, null, 2)
  if (containsSecretLike(text)) throw new Error('角色配置疑似包含机密')
  const files: Record<string, Uint8Array> = { 'role.json': Buffer.from(text) }
  const runId = `role-export-${randomUUID()}`
  try {
    for (const binding of template.skills) {
      const prepared = plugins.prepare(
        binding.skillId,
        template.projectId,
        runId,
      )
      Object.assign(
        files,
        packageFiles(prepared.directory, `skills/${binding.skillId}`),
      )
    }
    const path = join(target, `role-${randomUUID()}.reflexion-role.zip`)
    await writeFile(path, encodeArchive(files), { flag: 'wx', mode: 0o600 })
    return { path }
  } finally {
    plugins.releaseRun(runId)
  }
}

function inspectRolePackage(
  store: Store,
  plugins: SkillPluginService,
  data: string,
  projectId: string | null,
) {
  const decoded = decodeArchive(data)
  const temporary = mkdtempSync(join(tmpdir(), 'reflexion-role-'))
  try {
    if (
      !decoded.files['role.json'] ||
      decoded.files['role.json'].length > 256 * 1024
    )
      throw new Error('role.json 缺失或过大')
    const manifest = AgentRolePackageSchema.parse(
      JSON.parse(Buffer.from(decoded.files['role.json']).toString('utf8')),
    )
    const role: Omit<AgentTemplateSaveParams, 'requestId'> = {
      ...manifest.role,
      enabled: false,
      projectId,
      modelBinding: { mode: 'inherit' },
    }
    validateRoleTemplate(store, role)
    const bindings = role.skills ?? []
    const ids = new Set(bindings.map((item) => item.skillId))
    for (const [name, content] of Object.entries(decoded.files)) {
      if (name === 'role.json') continue
      const parts = name.split('/')
      if (
        parts.length < 3 ||
        parts[0] !== 'skills' ||
        !ids.has(parts[1]) ||
        !isSupportedPluginRootEntry(parts[2])
      )
        throw new Error('角色包含未声明的技能文件')
      const path = join(temporary, ...parts)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
    }
    const runId = `role-preview-${randomUUID()}`
    try {
      const skills = bindings.map((binding) => {
        const directory = join(temporary, 'skills', binding.skillId)
        const packaged = inspectPackage(directory)
        if (packaged.id !== binding.skillId)
          throw new Error('技能 id 与包目录不一致')
        // Verify package tree is exactly supported, without discarded root files.
        const incoming = packageFiles(directory)
        const installed = plugins
          .list()
          .find((plugin) => plugin.id === binding.skillId)
        if (installed) {
          const current = plugins.prepare(binding.skillId, projectId, runId)
          if (
            installed.version !== packaged.version ||
            contentDigest(incoming) !==
              contentDigest(packageFiles(current.directory))
          )
            throw new Error(
              `技能冲突：${binding.skillId}，请先处理已有技能；不会覆盖`,
            )
        }
        return {
          id: packaged.id,
          version: packaged.version,
          action: installed ? ('reuse' as const) : ('install' as const),
          directory,
        }
      })
      return { temporary, role, skills, digest: decoded.digest }
    } finally {
      plugins.releaseRun(runId)
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function previewRolePackage(
  store: Store,
  plugins: SkillPluginService,
  data: string,
  projectId: string | null,
) {
  const preview = inspectRolePackage(store, plugins, data, projectId)
  try {
    return {
      role: preview.role,
      digest: preview.digest,
      skills: preview.skills.map(({ id, version, action }) => ({
        id,
        version,
        action,
      })),
    }
  } finally {
    rmSync(preview.temporary, { recursive: true, force: true })
  }
}

export async function importRolePackage(
  store: Store,
  plugins: SkillPluginService,
  data: string,
  projectId: string | null,
  digest: string,
) {
  const preview = inspectRolePackage(store, plugins, data, projectId)
  const installed: string[] = []
  try {
    if (preview.digest !== digest) throw new Error('角色包已变化，请重新预览')
    for (const skill of preview.skills) {
      if (skill.action === 'reuse') continue
      await plugins.installRoleSkill(skill.directory, projectId)
      installed.push(skill.id)
    }
    resolveRoleSkills(preview.role, plugins.registry)
    return { template: store.agents.saveUser(preview.role) }
  } catch (error) {
    for (const id of installed.reverse()) plugins.uninstall(id)
    throw error
  } finally {
    rmSync(preview.temporary, { recursive: true, force: true })
  }
}
