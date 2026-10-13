import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Program locations only; never inspect Chrome profiles or browser credentials. */
export function systemChromeCandidates(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin')
    return ['/Applications', posix.join(home, 'Applications')].map((root) =>
      posix.join(
        root,
        'Google Chrome.app',
        'Contents',
        'MacOS',
        'Google Chrome',
      ),
    )
  if (platform === 'win32') {
    const get = (name: string) =>
      Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
    return [get('PROGRAMFILES'), get('PROGRAMFILES(X86)'), get('LOCALAPPDATA')]
      .filter(
        (root): root is string =>
          typeof root === 'string' && win32.isAbsolute(root),
      )
      .map((root) =>
        win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      )
  }
  if (platform === 'linux')
    return [
      '/opt/google/chrome/chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
    ]
  return []
}
export function detectSystemChrome(): string | null {
  for (const candidate of systemChromeCandidates()) {
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(
        candidate,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      )
      return candidate
    } catch {
      /* Not installed at this location. */
    }
  }
  return null
}
