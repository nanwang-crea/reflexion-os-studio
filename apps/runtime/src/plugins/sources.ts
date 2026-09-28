import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { PluginInstallSource } from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import {
  isIgnoredRootMetadataFile,
  isSupportedPluginRootEntry,
  resolvePackageDirectory,
} from './package.js'

export interface SourceResolutionOptions {
  signal?: AbortSignal
  onDownloadProgress?: (progress: number) => void
}

export async function resolveInstallSource(
  source: PluginInstallSource,
  store: Store,
  temporary: string,
  options: SourceResolutionOptions = {},
): Promise<{ directory: string; sourceRef: string }> {
  throwIfAborted(options.signal)
  if (source.source === 'dir') {
    const project = store.projects.get(source.projectId)
    if (!project?.folderPath)
      throw new Error(`project not found: ${source.projectId}`)
    return {
      directory: resolveWorkspacePath(project.folderPath, source.path),
      sourceRef: JSON.stringify({
        projectId: source.projectId,
        path: source.path,
      }),
    }
  }
  if (source.source === 'local') {
    if (!isAbsolute(source.path))
      throw new Error('local plugin path must be absolute')
    return {
      directory: resolvePackageDirectory(source.path),
      sourceRef: resolve(source.path),
    }
  }
  assertGitUrl(source.url)
  await cloneGitRepository(source.url, temporary, options)
  return { directory: temporary, sourceRef: source.url }
}

export function sourceForUpdate(
  source: 'dir' | 'git' | 'local',
  sourceRef: string | null,
): PluginInstallSource {
  if (sourceRef === null) throw new Error('plugin source is unavailable')
  if (source === 'git') return { source, url: sourceRef }
  if (source === 'local') return { source, path: sourceRef }
  if (source === 'dir') {
    let parsed: { projectId: string; path: string }
    try {
      parsed = JSON.parse(sourceRef) as { projectId: string; path: string }
    } catch {
      const separator = sourceRef.indexOf(':')
      if (separator <= 0) throw new Error('legacy workspace source is invalid')
      parsed = {
        projectId: sourceRef.slice(0, separator),
        path: sourceRef.slice(separator + 1),
      }
    }
    return { source, projectId: parsed.projectId, path: parsed.path }
  }
  throw new Error('builtin plugins cannot be updated')
}

export function copyPackage(
  source: string,
  target: string,
  isPackageRoot = true,
): void {
  mkdirSync(target)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('symlinks are not allowed')
    if (
      isPackageRoot &&
      (isIgnoredRootMetadataFile(entry.name, entry.isFile()) ||
        !isSupportedPluginRootEntry(entry.name))
    ) {
      continue
    }
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isDirectory()) copyPackage(sourcePath, targetPath, false)
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath)
    else throw new Error(`unsupported plugin entry: ${entry.name}`)
  }
}

export function cleanupTemporary(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function resolveWorkspacePath(rootPath: string, workspacePath: string): string {
  if (
    isAbsolute(workspacePath) ||
    /^[A-Za-z]:[\\/]/.test(workspacePath) ||
    workspacePath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error('path must be workspace-relative')
  }
  const root = realpathSync(rootPath)
  const candidate = resolve(root, workspacePath)
  const relativePath = relative(root, candidate)
  if (relativePath === '..' || relativePath.startsWith(`..${separator()}`)) {
    throw new Error('path escapes the workspace')
  }
  let cursor = root
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment)
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error('symlinks are not allowed in the source path')
    }
  }
  return resolvePackageDirectory(candidate)
}

function assertGitUrl(url: string): void {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('git source must be a credential-free HTTPS URL')
  }
}

async function cloneGitRepository(
  url: string,
  target: string,
  options: SourceResolutionOptions,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'credential.helper=',
        'clone',
        '--depth',
        '1',
        '--progress',
        '--config',
        'core.askPass=',
        url,
        target,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let stderr = ''
    let settled = false
    let terminationError: Error | null = null
    let forceKill: ReturnType<typeof setTimeout> | null = null
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKill !== null) clearTimeout(forceKill)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolvePromise()
    }
    const abort = (): void => {
      terminationError = abortError()
      child.kill()
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
    }
    const timeout = setTimeout(() => {
      terminationError = new Error('git clone timed out after 60 seconds')
      child.kill()
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
    }, 60_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192)
      const matches = [...stderr.matchAll(/(\d{1,3})%/g)]
      const percent = Number(matches.at(-1)?.[1])
      if (Number.isFinite(percent)) {
        options.onDownloadProgress?.(Math.min(100, percent))
      }
    })
    child.once('error', (error) => finish(terminationError ?? error))
    child.once('close', (code) => {
      if (terminationError !== null) return finish(terminationError)
      if (code !== 0) {
        return finish(new Error(`git clone failed: ${stderr.trim()}`))
      }
      finish()
    })
    if (options.signal?.aborted) abort()
  })
  rmSync(join(target, '.git'), { recursive: true, force: true })
}

export function abortError(): Error {
  const error = new Error('plugin task cancelled')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}
