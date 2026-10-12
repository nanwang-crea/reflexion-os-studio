import { useState } from 'react'
import {
  BrowserOriginSchema,
  type BrowserSettings,
  type BrowserSiteRule,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../components/forms/Select'
export function BrowserSitePermissions({
  settings,
  supported,
  save,
}: {
  settings: BrowserSettings
  supported: string[]
  save: (settings: BrowserSettings) => Promise<void>
}) {
  const [origin, setOrigin] = useState('')
  const [permission, setPermission] =
    useState<BrowserSiteRule['permission']>('camera')
  const [policy, setPolicy] = useState<BrowserSiteRule['policy']>('deny')
  const [notice, setNotice] = useState('')
  function add() {
    try {
      const rule = {
        origin: BrowserOriginSchema.parse(origin),
        permission,
        policy,
      }
      void save({
        ...settings,
        siteRules: [
          ...settings.siteRules.filter(
            (r) => r.origin !== rule.origin || r.permission !== permission,
          ),
          rule,
        ],
      })
      setNotice('')
    } catch (error) {
      setNotice(String(error))
    }
  }
  return (
    <fieldset className="browser-settings-card">
      <legend>网站权限</legend>
      <p className="hint">
        默认拒绝。询问规则只允许当前主页面逐次确认，不会永久授权。修改规则会关闭全部标签页以撤销现有权限。定位、通知、剪贴板及上传目前不开放。
      </p>
      <label>
        精确来源
        <input
          placeholder="https://example.com"
          value={origin}
          maxLength={8192}
          onChange={(event) => setOrigin(event.target.value)}
        />
      </label>
      <Select
        aria-label="网站权限类型"
        value={permission}
        onValueChange={(value) =>
          setPermission(value as BrowserSiteRule['permission'])
        }
      >
        <option value="camera" disabled={!supported.includes('camera')}>
          摄像头
        </option>
        <option value="microphone" disabled={!supported.includes('microphone')}>
          麦克风
        </option>
      </Select>
      <Select
        aria-label="网站权限策略"
        value={policy}
        onValueChange={(value) => setPolicy(value as BrowserSiteRule['policy'])}
      >
        <option value="deny">拒绝</option>
        <option value="ask" disabled={!supported.includes(permission)}>
          每次询问
        </option>
      </Select>
      <button
        type="button"
        disabled={!supported.includes(permission)}
        onClick={add}
      >
        保存规则
      </button>
      {settings.siteRules.map((rule) => (
        <div key={`${rule.origin}/${rule.permission}`}>
          {rule.origin} · {rule.permission} · {rule.policy}
          <button
            type="button"
            onClick={() =>
              void save({
                ...settings,
                siteRules: settings.siteRules.filter((r) => r !== rule),
              })
            }
          >
            移除规则并撤销
          </button>
        </div>
      ))}
      {notice && <p role="alert">{notice}</p>}
    </fieldset>
  )
}
