import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const DIST_BASE = 'https://nodejs.org/dist'

function distribution(version, platform, arch) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Node version: ${version}`)
  }
  const variants = {
    'darwin-arm64': ['darwin-arm64', '.tar.gz', 'bin/node'],
    'darwin-x64': ['darwin-x64', '.tar.gz', 'bin/node'],
    'linux-x64': ['linux-x64', '.tar.xz', 'bin/node'],
    'win32-x64': ['win-x64', '.zip', 'node.exe'],
  }
  const key = `${platform}-${arch}`
  const variant = variants[key]
  if (!variant) {
    throw new Error(
      `未支持的打包平台 ${key}（支持：${Object.keys(variants).join(', ')}）`,
    )
  }
  const [target, extension, inner] = variant
  const directory = `node-${version}-${target}`
  return { file: `${directory}${extension}`, directory, inner }
}

async function fetchFile(url, download) {
  try {
    const response = await download(url, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    throw new Error(`无法下载 ${url}；首次打包需要联网，请检查网络后重试`, {
      cause,
    })
  }
}

function expectedChecksum(text, file) {
  for (const line of text.split('\n')) {
    const [hex, name] = line.trim().split(/\s+/)
    if (name === file && /^[a-f\d]{64}$/i.test(hex)) {
      return hex.toLowerCase()
    }
  }
  throw new Error(`SHASUMS256.txt 中找不到有效校验值：${file}`)
}

/** 版本隔离的官方校验清单与压缩包缓存；每次重新校验并提取，防止沿用旧 Node。 */
export async function stageNodeRuntime({
  version,
  platform,
  arch,
  cacheDir,
  nodeOutDir,
  download = globalThis.fetch,
}) {
  const variant = distribution(version, platform, arch)
  mkdirSync(cacheDir, { recursive: true })
  const sumsPath = join(cacheDir, `${version}-SHASUMS256.txt`)
  const sums = existsSync(sumsPath)
    ? readFileSync(sumsPath, 'utf8')
    : (
        await fetchFile(`${DIST_BASE}/${version}/SHASUMS256.txt`, download)
      ).toString('utf8')
  const expectedHash = expectedChecksum(sums, variant.file)
  const archivePath = join(cacheDir, variant.file)
  const archive = existsSync(archivePath)
    ? readFileSync(archivePath)
    : await fetchFile(`${DIST_BASE}/${version}/${variant.file}`, download)
  const actualHash = createHash('sha256').update(archive).digest('hex')
  if (actualHash !== expectedHash) {
    rmSync(archivePath, { force: true })
    throw new Error(`SHA256 校验失败：${variant.file}，已删除缓存请重试`)
  }
  // 校验通过才保存下载结果；部分下载或错误响应不会污染下次离线构建。
  writeFileSync(sumsPath, sums)
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive)

  const extractedDir = mkdtempSync(join(cacheDir, 'extract-'))
  try {
    extract(archivePath, extractedDir)
    mkdirSync(nodeOutDir, { recursive: true })
    const nodeOut = join(nodeOutDir, platform === 'win32' ? 'node.exe' : 'node')
    copyFileSync(join(extractedDir, variant.directory, variant.inner), nodeOut)
    console.log(`node runtime staged: ${nodeOut}`)
  } finally {
    rmSync(extractedDir, { recursive: true, force: true })
  }
}

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
    execFileSync('unzip', ['-q', archive, '-d', dest], { stdio: 'inherit' })
  }
}
