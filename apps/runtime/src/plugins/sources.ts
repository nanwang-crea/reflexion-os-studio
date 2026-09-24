import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { PluginInstallSource } from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import { resolvePackageDirectory } from './package.js'

export function resolveInstallSource(
  source: PluginInstallSource,
  store: Store,
  temporary: string,
): { directory: string; sourceRef: string } {
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
  cloneGitRepository(source.url, temporary)
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

export function copyPackage(source: string, target: string): void {
  mkdirSync(target)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error('symlinks are not allowed')
    if (entry.isDirectory()) copyPackage(sourcePath, targetPath)
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
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('git source must be a credential-free HTTPS URL')
  }
}

function cloneGitRepository(url: string, target: string): void {
  const result = spawnSync(
    'git',
    [
      '-c',
      'credential.helper=',
      'clone',
      '--depth',
      '1',
      '--config',
      'core.askPass=',
      url,
      target,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000,
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `git clone failed: ${(result.stderr || result.error?.message || '').trim()}`,
    )
  }
  rmSync(join(target, '.git'), { recursive: true, force: true })
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}
