import { randomUUID } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  AgentRoleShareSchema,
  type AgentTemplate,
  MAX_AGENT_ROLE_SHARE_BYTES,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'
import { touchesSensitive } from '../permissions/escalation.js'
import { containsSecretLike } from '../instructions/secretGuard.js'

export async function exportRole(
  store: Store,
  templateId: string,
  directory: string,
) {
  const template = store.agents.list().find((role) => role.id === templateId)
  if (!template) throw new CommandError('not_found', '角色不存在')
  const archive = AgentRoleShareSchema.parse({
    format: 'reflexion-role',
    version: 1,
    role: portableRole(template),
  })
  return writeRoleShare(archive, directory, 'role', MAX_AGENT_ROLE_SHARE_BYTES)
}

export function portableRole(template: AgentTemplate) {
  return {
    name: template.name,
    description: template.description,
    systemPrompt: template.systemPrompt,
    domains: template.domains,
    ...(template.skills.length ? { skills: template.skills } : {}),
    permissionCeiling: template.policy.permissionCeiling,
    canDelegate: template.policy.canDelegate,
    allowedTools: template.policy.allowedTools,
  }
}

export async function writeRoleShare(
  archive: unknown,
  directory: string,
  kind: 'role' | 'team',
  maxBytes: number,
) {
  if (!isAbsolute(directory) || touchesSensitive(directory))
    throw new CommandError('invalid_request', '请选择普通目录')
  const target = await realpath(directory)
  if (touchesSensitive(target))
    throw new CommandError('invalid_request', '请选择普通目录')
  if (containsSecretLike(JSON.stringify(archive)))
    throw new CommandError('invalid_request', '角色配置疑似包含机密，拒绝导出')
  const content = `${JSON.stringify(archive, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > maxBytes)
    throw new CommandError('invalid_request', '角色文件超过大小上限')
  const path = join(target, `${kind}-${randomUUID()}.reflexion-${kind}.json`)
  await writeFile(path, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return { path }
}
