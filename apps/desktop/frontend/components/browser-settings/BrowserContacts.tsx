import { useEffect, useState } from 'react'
import {
  BrowserContactSchema,
  type BrowserContact,
  type BrowserSettings,
} from '@reflexion-os-studio/contracts'
import {
  listBrowserContacts,
  saveBrowserContact,
  deleteBrowserContact,
} from '../../api/browser-data'
import { browserSession } from '../../api/browser'
const empty = (): BrowserContact => ({
  id: crypto.randomUUID(),
  label: '',
  name: '',
  email: '',
  phone: '',
  address: '',
})
export function BrowserContacts({
  settings,
  supported,
  save,
}: {
  settings: BrowserSettings
  supported: boolean
  save: (settings: BrowserSettings) => Promise<void>
}) {
  const [contacts, setContacts] = useState<BrowserContact[]>([])
  const [draft, setDraft] = useState(empty)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let disposed = false
    void listBrowserContacts()
      .then((result) => {
        if (!disposed) setContacts(result.contacts)
      })
      .catch((error) => {
        if (!disposed) setNotice(String(error))
      })
    return () => {
      disposed = true
    }
  }, [])
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true)
    setNotice('')
    try {
      await operation()
      setContacts((await listBrowserContacts()).contacts)
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="browser-settings-card" disabled={busy}>
      <legend>联系信息</legend>
      <p className="hint">
        仅保存你明确输入的信息。手动填充前显示网站来源并再次确认，不自动提交。
      </p>
      <label>
        <input
          type="checkbox"
          disabled={!supported}
          className="ui-switch"
          role="switch"
          checked={settings.contactAutofill}
          onChange={(event) =>
            void save({ ...settings, contactAutofill: event.target.checked })
          }
        />
        允许手动填充联系信息
      </label>
      {contacts.map((contact) => (
        <div key={contact.id}>
          {contact.label}
          <button type="button" onClick={() => setDraft(contact)}>
            编辑
          </button>
          <button
            type="button"
            onClick={() => void perform(() => deleteBrowserContact(contact.id))}
          >
            删除
          </button>
          <button
            type="button"
            disabled={!supported || !settings.contactAutofill}
            onClick={() =>
              void perform(() =>
                browserSession.control({ kind: 'fillcontact', contact }),
              )
            }
          >
            填充到当前网页…
          </button>
        </div>
      ))}
      {(['label', 'name', 'email', 'phone', 'address'] as const).map((key) => (
        <label key={key}>
          {
            {
              label: '名称',
              name: '姓名',
              email: '邮箱',
              phone: '电话',
              address: '地址',
            }[key]
          }
          <input
            value={draft[key]}
            maxLength={
              key === 'address'
                ? 1000
                : key === 'email'
                  ? 254
                  : key === 'name'
                    ? 200
                    : 100
            }
            onChange={(event) =>
              setDraft({ ...draft, [key]: event.target.value })
            }
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() =>
          void perform(async () => {
            await saveBrowserContact(BrowserContactSchema.parse(draft))
            setDraft(empty())
          })
        }
      >
        保存
      </button>
      <button type="button" onClick={() => setDraft(empty())}>
        新建
      </button>
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  )
}
