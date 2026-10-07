#!/usr/bin/env node
// 下载并校验随安装包分发的官方 Node；缓存命中时可离线构建。
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageNodeRuntime } from './node-dist/stage.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await stageNodeRuntime({
  version: process.env.REFLEXION_NODE_VERSION ?? 'v22.21.1',
  platform: process.platform,
  arch: process.arch,
  cacheDir: join(repoRoot, '.cache', 'node-dist'),
  nodeOutDir: join(
    repoRoot,
    'apps',
    'desktop',
    'src-tauri',
    'package-resources',
    'node',
    'bin',
  ),
})
