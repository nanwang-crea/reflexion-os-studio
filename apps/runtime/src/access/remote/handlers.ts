import type { CommandHandler, CommandContext } from '../../command-utils.js'
import { CommandError } from '../../agent/errors.js'
function service(ctx: CommandContext) {
  if (!ctx.remote) throw new CommandError('unsupported', '手机接入服务不可用')
  return ctx.remote
}
export const remoteCommandHandlers: Record<string, CommandHandler> = {
  'remote.catalog': (_p, { store }) => ({
    projects: store.projects.list().map(({ id, name }) => ({ id, name })),
    models: store.providers
      .list()
      .filter((provider) => provider.enabled)
      .flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          model,
        })),
      ),
  }),
  'remote.status': (_p, ctx) => service(ctx).status(),
  'remote.start': (p, ctx) => service(ctx).start(String(p.address)),
  'remote.invite': (_p, ctx) => service(ctx).invite(),
  'remote.stop': async (_p, ctx) => {
    await service(ctx).stop()
    return { ok: true }
  },
  'remote.device.resolve': (p, ctx) => ({
    accepted: service(ctx).resolve(String(p.deviceId), p.approved === true),
  }),
  'remote.device.revoke': (p, ctx) => ({
    removed: service(ctx).revoke(String(p.deviceId)),
  }),
}
