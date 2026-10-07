import { dirname, basename, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A controlled npm installation: protocol fixture instead of downloading npm or packages.
export function npmInstallation(directory, launcherName) {
  const launcher = join(directory, launcherName)
  const folder = dirname(launcher)
  const packageDirectory =
    basename(folder) === '.bin'
      ? resolve(folder, '..', 'npm')
      : join(folder, 'node_modules', 'npm')
  mkdirSync(join(packageDirectory, 'bin'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'npm',
      type: 'module',
      bin: { npm: 'bin/npm-cli.js', npx: 'bin/npx-cli.js' },
    }),
  )
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'mock-mcp-server.mjs'),
  )
  for (const name of ['npm', 'npx'])
    writeFileSync(join(packageDirectory, 'bin', `${name}-cli.js`), source)
  const name = basename(launcher).replace(/\.cmd$/i, '')
  const relative =
    basename(folder) === '.bin'
      ? `../npm/bin/${name}-cli.js`
      : `node_modules/npm/bin/${name}-cli.js`
  writeFileSync(
    launcher,
    `@echo off\r\n"${process.execPath}" "%~dp0${relative.replaceAll('/', '\\')}" %*\r\n`,
  )
  return {
    launcher,
    cli: join(packageDirectory, 'bin', `${name}-cli.js`),
    packageDirectory,
  }
}
