import type {
  BrowserContact,
  BrowserVisit,
} from '@reflexion-os-studio/contracts'
import { request } from './client'

export const listBrowserHistory = (query = '', before?: number) =>
  request<{ visits: BrowserVisit[] }>('browser_history.list', { query, before })
export const recordBrowserVisit = (url: string, title: string) =>
  request<{ recorded: boolean }>('browser_history.record', {
    url,
    title: title.slice(0, 500),
  })
export const clearBrowserHistory = (origin?: string) =>
  request<{ removed: number }>('browser_history.clear', { origin })
export const listBrowserContacts = () =>
  request<{ contacts: BrowserContact[] }>('browser_contacts.list')
export const saveBrowserContact = (contact: BrowserContact) =>
  request<{ contact: BrowserContact }>('browser_contacts.save', { contact })
export const deleteBrowserContact = (id: string) =>
  request<{ removed: boolean }>('browser_contacts.delete', { id })
