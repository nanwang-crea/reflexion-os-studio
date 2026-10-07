import { posix, win32 } from 'node:path'

/** 保留盘符/UNC/POSIX 根的分隔符；兼容旧版误存的 Windows 盘符根 C:。 */
export function normalizeProjectFolderPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (value === '') return value
  const paths = platform === 'win32' ? win32 : posix
  const input =
    platform === 'win32' && /^[A-Za-z]:$/.test(value) ? `${value}\\` : value
  const root = paths.parse(input).root
  const trimmed = input.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
  return trimmed.length < root.length ? paths.normalize(root) : trimmed
}
