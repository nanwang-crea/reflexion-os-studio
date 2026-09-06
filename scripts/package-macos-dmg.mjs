#!/usr/bin/env node
// 跨平台守卫：仅在 macOS 上调用 bash 版 DMG 打包脚本（生成拖拽安装布局的
// .dmg）；Windows/Linux 的安装包（msi/nsis、deb/AppImage）由 tauri build
// 依据 tauri.conf.json 的 bundle.targets 在各自平台完成，此处直接退出。
// 用 Node 而非在 package.json 里 `&& bash`，是为了让 Windows 机器上
// `pnpm build:desktop` 无需预装 bash。
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'bash',
  [join(repoRoot, 'scripts', 'package-macos-dmg.sh')],
  {
    stdio: 'inherit',
  },
)
process.exit(result.status ?? 1)
