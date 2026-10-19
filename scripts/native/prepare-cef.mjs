import {
  cp,
  mkdir,
  readFile,
  writeFile,
  access,
  readdir,
} from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = join(root, 'scripts/native/cef-runtime/Cargo.toml')
const target = resolve(
  process.env.CARGO_TARGET_DIR ?? join(root, 'apps/desktop/src-tauri/target'),
)
const output = join(root, '.cache/cef-native')
if (!['darwin', 'win32'].includes(process.platform)) {
  console.log(
    'CEF embedded browser is unavailable on this platform; retaining explicit fallback',
  )
  process.exit(0)
}
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error || result.status !== 0)
    throw new Error(`CEF preparation failed: ${command}`)
  return result.stdout.trim()
}
run('cargo', [
  'build',
  '--manifest-path',
  manifest,
  '--target-dir',
  target,
  '--bin',
  'reflexion-cef-distribution',
  '--bin',
  'reflexion-cef-helper',
])
const executable = join(
  target,
  'debug',
  `reflexion-cef-distribution${process.platform === 'win32' ? '.exe' : ''}`,
)
const distribution = run(executable, ['--cef-distribution'])
await mkdir(output, { recursive: true })
async function copyLicenses(destination) {
  await mkdir(destination, { recursive: true })
  await cp(
    join(distribution, 'CREDITS.html'),
    join(destination, 'CREDITS.html'),
  )
  for (const name of ['CEF-LICENSE.txt', 'CEF-RS-LICENSE-MIT.txt'])
    await writeFile(
      join(destination, name),
      await readFile(new URL(name, import.meta.url)),
    )
}

if (process.platform === 'darwin') {
  const contents = join(output, 'ReflexionOS Studio Dev.app/Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await writeFile(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>reflexion-desktop</string><key>CFBundleIdentifier</key><string>com.reflexionos.studio.cefdev</string><key>CFBundleName</key><string>ReflexionOS CEF Dev</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
  await copyLicenses(join(contents, 'Resources/cef-licenses'))
  const frameworks = join(contents, 'Frameworks')
  await mkdir(frameworks, { recursive: true })
  await cp(
    join(distribution, 'Chromium Embedded Framework.framework'),
    join(frameworks, 'Chromium Embedded Framework.framework'),
    { recursive: true, verbatimSymlinks: true },
  )
  for (const suffix of [
    'Helper',
    'Helper (GPU)',
    'Helper (Renderer)',
    'Helper (Plugin)',
    'Helper (Alerts)',
  ]) {
    const name = `reflexion-desktop ${suffix}`
    const contents = join(frameworks, `${name}.app/Contents`)
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await cp(
      join(target, 'debug/reflexion-cef-helper'),
      join(contents, `MacOS/${name}`),
    )
    const identifier = `com.reflexionos.studio.cef.${suffix.replaceAll(/[^a-z]/gi, '').toLowerCase()}`
    await writeFile(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>0.1.0</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>11.0</string></dict></plist>`,
    )
  }
} else {
  // CEF's official bootstrap supplies the sandbox broker to RunWinMain in the DLL.
  const windows = join(output, 'windows')
  await mkdir(windows, { recursive: true })
  for (const source of ['Release', 'Resources']) {
    try {
      await cp(join(distribution, source), windows, { recursive: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  // Official cef-rs distributions are flat; upstream CEF archives use Release/Resources.
  for (const entry of await readdir(distribution, { withFileTypes: true })) {
    if (
      (entry.isDirectory() && entry.name === 'locales') ||
      (entry.isFile() &&
        /\.(dll|pak|dat|bin|json|txt|html|exe)$/i.test(entry.name))
    ) {
      await cp(join(distribution, entry.name), join(windows, entry.name), {
        recursive: true,
      })
    }
  }
  await copyLicenses(join(windows, 'cef-licenses'))
  await access(join(windows, 'bootstrap.exe'))
  await cp(windows, join(target, 'debug'), { recursive: true })
  await cp(
    join(windows, 'bootstrap.exe'),
    join(target, 'debug/reflexion-desktop-sandbox.exe'),
  )
  // Tauri validates bundle resource paths even for this preparatory DLL build.
  // prepare-package.sh stages their contents after CEF preparation completes;
  // standalone prepare:cef (including tauri dev) also needs the directory.
  await mkdir(join(root, 'apps/desktop/src-tauri/package-resources'), {
    recursive: true,
  })
  run('cargo', [
    'build',
    '--manifest-path',
    join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '--lib',
  ])
  await cp(
    join(target, 'debug/reflexion_desktop_lib.dll'),
    join(target, 'debug/reflexion-desktop-sandbox.dll'),
  )
}
await writeFile(
  join(output, 'distribution.json'),
  JSON.stringify({
    path: distribution,
    version: '154.5.0+154.0.34',
    platform: process.platform,
    arch: process.arch,
  }) + '\n',
)
// Check the generated platform config before the bundler consumes it.
await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'))
console.log(`CEF native resources staged: ${output}`)
