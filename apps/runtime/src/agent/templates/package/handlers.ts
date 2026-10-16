import { agentTemplateCommands } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../../../command-utils.js'
import { CommandError } from '../../errors.js'
import { exportRole } from '../share.js'
import {
  exportRolePackage,
  previewRolePackage,
  importRolePackage,
} from './service.js'

function checked(handler: CommandHandler): CommandHandler {
  return async (params, context) => {
    try {
      return await handler(params, context)
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError(
        'invalid_request',
        error instanceof Error ? error.message : '角色包操作失败',
      )
    }
  }
}

export const rolePackageHandlers: Record<string, CommandHandler> = {
  'agent_template.package_preview': checked((p, { store, plugins }) => {
    const input =
      agentTemplateCommands['agent_template.package_preview'].params.parse(p)
    return previewRolePackage(store, plugins, input.data, input.projectId)
  }),
  'agent_template.package_import': checked((p, { store, plugins }) => {
    const input =
      agentTemplateCommands['agent_template.package_import'].params.parse(p)
    return importRolePackage(
      store,
      plugins,
      input.data,
      input.projectId,
      input.digest,
    )
  }),
  'agent_template.export': checked((p, { store, plugins }) => {
    const input = agentTemplateCommands['agent_template.export'].params.parse(p)
    return input.includeSkills
      ? exportRolePackage(store, plugins, input.templateId, input.directory)
      : exportRole(store, input.templateId, input.directory)
  }),
}
