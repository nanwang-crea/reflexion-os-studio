import { isBrowserInstallation } from './installation/record.js'
import { publishBrowserInstallation } from './installation/publish.js'
import { detectSystemChrome } from './sources/chrome.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import {
  AgentBrowserInstallationSchema,
  type AgentBrowserRuntime,
  type AgentBrowserSource,
  type AgentBrowserLaunch,
} from '@reflexion-os-studio/contracts'
import { browserRuntimePaths } from './paths.js'
import { runBrowserInstaller } from './installation/process.js'

export class BrowserRuntimeService {
  private current: AgentBrowserRuntime
  private task: Promise<void> | null = null
  private controller: AbortController | null = null
  private readonly paths: ReturnType<typeof browserRuntimePaths> | null
  constructor(
    dataDir: string,
    private readonly run = runBrowserInstaller,
    paths?: ReturnType<typeof browserRuntimePaths>,
    private readonly detectChrome = detectSystemChrome,
  ) {
    try {
      this.paths = paths ?? browserRuntimePaths(dataDir)
    } catch {
      this.paths = null
    }
    this.current = {
      systemChromeAvailable: this.detectChrome() !== null,
      state: 'not-installed',
      phase: 'idle',
      progress: null,
      version: this.paths?.version ?? 'unavailable',
      error: this.paths ? null : 'runtime-unavailable',
    }
  }
  get status(): AgentBrowserRuntime {
    if (this.current.state !== 'downloading') {
      if (this.isInstalled())
        this.current = {
          ...this.current,
          state: 'installed',
          phase: 'ready',
          progress: null,
          error: null,
        }
      else if (this.current.state === 'installed')
        this.current = {
          ...this.current,
          state: 'not-installed',
          phase: 'idle',
        }
    }
    return {
      ...this.current,
      systemChromeAvailable: this.detectChrome() !== null,
    }
  }
  requireInstalled(): string {
    if (this.status.state !== 'installed' || !this.paths)
      throw new Error('browser_runtime_not_installed')
    return this.paths.browsers
  }
  resolveLaunch(source: AgentBrowserSource): {
    launch: AgentBrowserLaunch
    browsers?: string
  } {
    const chrome = source !== 'managed' ? this.detectChrome() : null
    const managed = this.current.state !== 'downloading' && this.isInstalled()
    if (chrome)
      return {
        launch: {
          channel: 'chrome',
          executablePath: chrome,
          fallbackManaged: source === 'auto' && managed,
        },
        ...(managed ? { browsers: this.paths!.browsers } : {}),
      }
    if (source === 'system-chrome')
      throw new Error('browser_system_chrome_unavailable')
    return {
      launch: { channel: 'chromium', fallbackManaged: false },
      browsers: this.requireInstalled(),
    }
  }
  install(): AgentBrowserRuntime {
    if (this.task || this.status.state === 'installed') return this.status
    if (!this.paths) {
      this.current = {
        ...this.current,
        state: 'failed',
        phase: 'failed',
        error: 'runtime-unavailable',
      }
      return this.status
    }
    this.controller = new AbortController()
    this.current = {
      ...this.current,
      state: 'downloading',
      phase: 'download',
      progress: null,
      error: null,
    }
    this.task = this.download(this.controller.signal).then((error) => {
      this.task = null
      this.controller = null
      this.current = {
        ...this.current,
        state: error ? 'failed' : 'installed',
        phase: error ? 'failed' : 'ready',
        progress: null,
        error,
      }
    })
    return this.status
  }
  cancel(): AgentBrowserRuntime {
    this.controller?.abort()
    return this.status
  }
  async shutdown(): Promise<void> {
    this.cancel()
    await this.task
  }
  private isInstalled(): boolean {
    return (
      this.paths !== null &&
      isBrowserInstallation(this.paths.browsers, this.paths.version)
    )
  }
  private async download(
    signal: AbortSignal,
  ): Promise<'download-cancelled' | 'download-failed' | null> {
    const paths = this.paths!
    let staging: string | null = null
    let error: 'download-cancelled' | 'download-failed' | null = null
    try {
      await mkdir(paths.root, { recursive: true })
      // Only our installer writes here. Remove abandoned partial downloads after restart.
      const temporary = join(paths.root, 'staging')
      await rm(temporary, { recursive: true, force: true })
      await mkdir(temporary, { recursive: true })
      staging = await mkdtemp(join(temporary, 'download-'))
      let pending = ''
      await this.run(
        paths.cli,
        ['install', 'chromium', '--no-shell'],
        staging,
        signal,
        (text) => {
          pending = (pending + text).slice(-4096)
          const percentages = [...pending.matchAll(/\b(\d{1,3})%/g)]
          const last = percentages.at(-1)
          if (last)
            this.current = {
              ...this.current,
              progress: Math.min(100, Number(last[1])),
            }
        },
      )
      signal.throwIfAborted()
      this.current = { ...this.current, phase: 'verify', progress: null }
      const result = AgentBrowserInstallationSchema.pick({
        executable: true,
      }).parse(
        JSON.parse(await this.run(paths.probe, [], staging, signal, () => {})),
      )
      const executable = relative(staging, result.executable)
      if (
        !executable ||
        executable.startsWith('..') ||
        isAbsolute(executable) ||
        !existsSync(result.executable)
      )
        throw new Error('download-failed')
      await writeFile(
        join(staging, 'installed.json'),
        JSON.stringify({ version: paths.version, executable }),
        'utf8',
      )
      signal.throwIfAborted()
      if (!isBrowserInstallation(staging, paths.version))
        throw new Error('download-failed')
      await publishBrowserInstallation(
        staging,
        paths.browsers,
        signal,
        undefined,
        (directory) => isBrowserInstallation(directory, paths.version),
      )
      staging = null
    } catch {
      error = signal.aborted ? 'download-cancelled' : 'download-failed'
    } finally {
      if (staging)
        await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
    return error
  }
}
