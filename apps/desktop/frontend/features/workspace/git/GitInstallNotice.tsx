import { useState } from 'react'
import { openExternalUrl } from '../../../api/system'
import './git-install.css'

export function GitInstallNotice({
  onRetry,
}: {
  onRetry: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const open = (url: string): void => {
    setError(null)
    void openExternalUrl(url).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    )
  }
  return (
    <section className="git-install-notice" role="alert">
      <strong>需要安装 Git 才能使用此功能</strong>
      <p>未找到可用的 Git 命令。安装完成后重启应用，再点击重试。</p>
      <ul>
        <li>
          macOS：安装 Xcode Command Line Tools（xcode-select
          --install），或按官网说明安装。
        </li>
        <li>Windows：安装 Git for Windows，并选择将 Git 加入 PATH。</li>
        <li>
          Linux：通过发行版包管理器安装 git，例如 apt install git 或 dnf install
          git。
        </li>
      </ul>
      <div className="git-install-actions">
        <button onClick={() => open('https://git-scm.com/downloads')}>
          打开 Git 官方安装页
        </button>
        <button
          className="ghost"
          onClick={() => open('https://gitforwindows.org/')}
        >
          Git for Windows
        </button>
        <button className="ghost" onClick={onRetry}>
          安装后重试
        </button>
      </div>
      {error && <p>{error}</p>}
    </section>
  )
}
