import type { CommandHandler } from '../../command-utils.js'
import { BrowserContactSchema } from '@reflexion-os-studio/contracts'

export const browserDataCommandHandlers: Record<string, CommandHandler> = {
  'browser_history.list': (params, { store }) => ({
    visits: store.browserHistory.list(
      String(params.query ?? ''),
      Number(params.limit ?? 100),
      params.before === undefined ? undefined : Number(params.before),
    ),
  }),
  'browser_history.record': (params, { store }) => {
    const settings = store.browserSettings.get()
    const recorded =
      settings.mode === 'embedded' &&
      settings.storageMode === 'persistent' &&
      settings.saveHistory
    if (recorded)
      store.browserHistory.record(String(params.url), String(params.title))
    return { recorded }
  },
  'browser_history.clear': (params, { store }) => ({
    removed: store.browserHistory.clear(
      params.origin === undefined ? undefined : String(params.origin),
    ),
  }),
  'browser_contacts.list': (_params, { store }) => ({
    contacts: store.browserContacts.list(),
  }),
  'browser_contacts.save': (params, { store }) => ({
    contact: store.browserContacts.save(
      BrowserContactSchema.parse(params.contact),
    ),
  }),
  'browser_contacts.delete': (params, { store }) => ({
    removed: store.browserContacts.delete(String(params.id)),
  }),
}
