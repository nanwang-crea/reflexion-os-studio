import { setThemePreference, type ThemePreference } from '../../../lib/theme'
import { useTheme } from '../../../lib/theme/useTheme'
import './appearance.css'

const options: {
  value: ThemePreference
  label: string
  description: string
}[] = [
  { value: 'light', label: '浅色', description: '白色内容区与柔和的浅灰侧栏' },
  { value: 'dark', label: '深色', description: '深灰背景与低亮度界面' },
  {
    value: 'system',
    label: '跟随系统',
    description: '随系统的浅色或深色外观切换',
  },
]

export function AppearancePanel(): React.JSX.Element {
  const { preference } = useTheme()
  return (
    <section className="settings-panel">
      <div className="settings-panel-head settings-page-heading">
        <h3 className="settings-panel-title">外观</h3>
        <p className="hint">主题立即应用到所有页面，并在下次启动时保留。</p>
      </div>
      <fieldset className="appearance-options">
        <legend>配色主题</legend>
        {options.map(({ value, label, description }) => (
          <label className="appearance-option" key={value}>
            <span
              className={`appearance-preview appearance-preview-${value}`}
              aria-hidden="true"
            >
              <span />
              <span>
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="appearance-label">
              <input
                type="radio"
                name="theme"
                value={value}
                checked={preference === value}
                onChange={() => setThemePreference(value)}
              />
              <strong>{label}</strong>
            </span>
            <span className="hint">{description}</span>
          </label>
        ))}
      </fieldset>
    </section>
  )
}
