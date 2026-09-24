import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveWorkspaceSource(
  rootPath: string,
  workspacePath: string,
): string {
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
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('path escapes the workspace')
  }
  let cursor = root
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment)
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error('symlinks are not allowed in the source path')
    }
  }
  return candidate
}

export function assertTreeHasNoSymlinks(directory: string): void {
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error('symlinks are not allowed')
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('symlinks are not allowed')
    if (entry.isDirectory()) assertTreeHasNoSymlinks(path)
  }
}

export function copyDirectory(source: string, target: string): void {
  mkdirSync(target)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error('symlinks are not allowed')
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath)
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath)
    else throw new Error(`unsupported plugin entry: ${entry.name}`)
  }
}
