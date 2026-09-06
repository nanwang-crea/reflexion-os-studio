#!/usr/bin/env node
// 下载与本项目 Runtime 兼容的 Node 官方发行版，提取出 node 可执行文件，
// 供桌面安装包随包分发（打包产物不再依赖目标机器预装 Node）。
//
// 仅提取 bin/node(.exe)；下载内容缓存在仓库 .cache/node-dist/，
// 重复构建不会重新下载。版本可用 REFLEXION_NODE_VERSION 覆盖。
//
// 平台映射（当前支持）：darwin-arm64 / darwin-x64 / linux-x64 / win-x64，
// 均使用官方发行版 tarball/zip，SHA256 校验后再提取。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = process.env.REFLEXION_NODE_VERSION ?? 'v22.21.1'
const NODE_DIST_BASE = 'https://nodejs.org/dist'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(repoRoot, '.cache', 'node-dist')
const nodeOutDir = join(
  repoRoot,
  'apps',
  'desktop',
  'src-tauri',
  'package-resources',
  'node',
  'bin',
)
const nodeOut = join(
  nodeOutDir,
  process.platform === 'win32' ? 'node.exe' : 'node',
)

const sha256sums = new Map()
for (const line of await fetch(
  `${NODE_DIST_BASE}/${NODE_VERSION}/SHASUMS256.txt`,
)
  .then((res) => {
    if (!res.ok) throw new Error(`SHASUMS256.txt ${res.status}`)
    return res.text()
  })
  .then((text) => text.split('\n'))) {
  const [hex, name] = line.trim().split(/\s+/)
  if (hex && name) sha256sums.set(name, hex)
}

const variants = {
  'darwin-arm64': {
    file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    inner: 'bin/node',
  },
  'darwin-x64': {
    file: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    inner: 'bin/node',
  },
  'linux-x64': {
    file: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    inner: 'bin/node',
  },
  'win32-x64': { file: `node-${NODE_VERSION}-win-x64.zip`, inner: 'node.exe' },
}
const platformKey = `${process.platform}-${process.arch}`
const variant = variants[platformKey]
if (!variant) {
  throw new Error(
    `未支持的打包平台 ${platformKey}（支持：${Object.keys(variants).join(', ')}）`,
  )
}

// 已就位则跳过：安装包资源目录里的产物视为最新（会随 clean 一并清理）。
if (existsSync(nodeOut)) {
  console.log(`node runtime already staged: ${nodeOut}`)
  process.exit(0)
}

const expectedHash = sha256sums.get(variant.file)
if (!expectedHash) {
  throw new Error(`SHASUMS256.txt 中找不到 ${variant.file}`)
}

const archivePath = join(cacheDir, variant.file)
const extractedDir = join(
  cacheDir,
  variant.file.replace(/(\.tar\.gz|\.tar\.xz|\.zip)$/, ''),
)
mkdirSync(cacheDir, { recursive: true })

if (!existsSync(archivePath)) {
  console.log(`downloading ${NODE_DIST_BASE}/${NODE_VERSION}/${variant.file}`)
  const response = await fetch(
    `${NODE_DIST_BASE}/${NODE_VERSION}/${variant.file}`,
  )
  if (!response.ok) throw new Error(`download failed: ${response.status}`)
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))
}

const actualHash = createHash('sha256')
  .update(readFileSync(archivePath))
  .digest('hex')
if (actualHash !== expectedHash) {
  rmSync(archivePath, { force: true })
  throw new Error(`SHA256 校验失败：${variant.file}，已删除缓存请重试`)
}

if (!existsSync(extractedDir)) {
  console.log(`extracting ${variant.file}`)
  extract(archivePath, cacheDir)
}

mkdirSync(nodeOutDir, { recursive: true })
copyFileSync(join(extractedDir, variant.inner), nodeOut)
console.log(`node runtime staged: ${nodeOut}`)

function extract(archive, dest) {
  const args = archive.endsWith('.zip')
    ? ['-xf', archive, '-C', dest]
    : archive.endsWith('.tar.xz')
      ? ['-xJf', archive, '-C', dest]
      : ['-xzf', archive, '-C', dest]
  try {
    execFileSync('tar', args, { stdio: 'inherit' })
  } catch (error) {
    if (!archive.endsWith('.zip')) throw error
    // GNU tar 不支持 zip：回退到 unzip（Windows 自带 bsdtar 已覆盖该分支）。
    execFileSync('unzip', ['-q', archive, '-d', dest], { stdio: 'inherit' })
  }
}
