import { setThemePreference, type ThemePreference } from '../../../lib/theme'
import { useTheme } from '../../../lib/theme/useTheme'
import {
  setRunDisplayMode,
  useRunDisplayMode,
  type RunDisplayMode,
} from '../../../hooks/ui/runDisplayMode'
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

const runDisplayOptions: {
  value: RunDisplayMode
  label: string
  description: string
}[] = [
  {
    value: 'detailed',
    label: '详细',
    description: '展开思考过程、工具轨迹与过程正文。',
  },
  {
    value: 'standard',
    label: '标准',
    description: '单行活动状态 + 思考摘要 + 最终回答，接近 DeepSeek Harness。',
  },
]

export function AppearancePanel(): React.JSX.Element {
  const { preference } = useTheme()
  const runDisplayMode = useRunDisplayMode()
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
      <fieldset className="appearance-options">
        <legend>工作步骤显示</legend>
        {runDisplayOptions.map(({ value, label, description }) => (
          <label
            className="appearance-option appearance-option-plain"
            key={value}
          >
            <span className="appearance-label">
              <input
                type="radio"
                name="run-display-mode"
                value={value}
                checked={runDisplayMode === value}
                onChange={() => setRunDisplayMode(value)}
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
