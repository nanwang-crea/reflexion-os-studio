import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../command-utils.js'
import { CommandError } from '../agent/errors.js'

function params<K extends keyof typeof CommandSchemaRegistry>(
  method: K,
  input: Record<string, unknown>,
): ReturnType<(typeof CommandSchemaRegistry)[K]['params']['parse']> {
  const parsed = CommandSchemaRegistry[method].params.safeParse(input)
  if (!parsed.success)
    throw new CommandError('invalid_request', '开发者查询参数无效')
  const data = parsed.data
  if (
    'from' in data &&
    'to' in data &&
    typeof data.from === 'string' &&
    typeof data.to === 'string' &&
    Date.parse(data.from) >= Date.parse(data.to)
  )
    throw new CommandError('invalid_request', '开始时间必须早于结束时间')
  return data as ReturnType<
    (typeof CommandSchemaRegistry)[K]['params']['parse']
  >
}

export const developerCommandHandlers: Record<string, CommandHandler> = {
  'developer.overview': (p, { store }) =>
    store.developer.overview.get(params('developer.overview', p)),
  'developer.runs.list': (p, { store }) =>
    store.developer.runs.list(params('developer.runs.list', p)),
  'developer.run.get': (p, { store }) => ({
    detail: store.developer.runs.get(params('developer.run.get', p).runId),
  }),
  'developer.tools.list': (p, { store }) =>
    store.developer.tools.list(params('developer.tools.list', p)),
  'developer.tool.get': (p, { store }) => ({
    detail: store.developer.tools.get(
      params('developer.tool.get', p).toolCallId,
    ),
  }),
  'developer.models.list': (p, { store }) =>
    store.developer.models.list(params('developer.models.list', p)),
  'developer.attempts.list': (p, { store }) => {
    const input = params('developer.attempts.list', p)
    return store.developer.models.attempts(
      input.messageId,
      input.offset,
      input.limit,
    )
  },
}
