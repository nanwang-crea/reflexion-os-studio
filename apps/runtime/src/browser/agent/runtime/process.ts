import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'

/** Only launches the shipped Node/Playwright entry points; never invokes a shell. */
export function runBrowserInstaller(
  script: string,
  args: string[],
  browsers: string,
  signal: AbortSignal,
  onOutput: (text: string) => void,
): Promise<string> {
  signal.throwIfAborted()
  const env = { ...process.env }
  // Fixed official distribution and isolated cache, regardless of inherited overrides.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('PLAYWRIGHT_')) delete env[key]
  }
  env.PLAYWRIGHT_BROWSERS_PATH = browsers
  env.CI = '1'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let output = ''
    const stop = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'taskkill.exe',
          ),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error) child.kill()
          },
        )
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill()
        }
      }
    }
    const timer = setTimeout(stop, 20 * 60 * 1000)
    timer.unref()
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output = (output + text).slice(-8192)
      onOutput(text)
    })
    child.stderr.on('data', () => {}) // Do not expose raw installer diagnostics.
    child.once('error', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      reject(new Error('download-failed'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (signal.aborted) reject(new Error('download-cancelled'))
      else if (code !== 0) reject(new Error('download-failed'))
      else resolve(output)
    })
  })
}
