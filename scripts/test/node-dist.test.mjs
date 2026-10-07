import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageNodeRuntime } from '../node-dist/stage.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-node-dist-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = {
    version: 'v22.21.1',
    platform: 'darwin',
    arch: 'arm64',
    cacheDir: join(root, 'cache'),
    nodeOutDir: join(root, 'staged'),
  }
  const makeArchive = (version, content) => {
    const directory = `node-${version}-darwin-arm64`
    const source = join(root, directory, 'bin')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'node'), content, { mode: 0o755 })
    const file = `${directory}.tar.gz`
    const path = join(root, file)
    execFileSync('tar', ['-czf', path, '-C', root, directory])
    const archive = readFileSync(path)
    const checksum = createHash('sha256').update(archive).digest('hex')
    return { archive, file, sums: `${checksum}  ${file}\n` }
  }
  return { options, makeArchive }
}

test('downloads verified Node once, then restores staged files entirely offline', async (t) => {
  const { options, makeArchive } = fixture(t)
  const dist = makeArchive(options.version, 'first Node')
  const requests = []
  await stageNodeRuntime({
    ...options,
    download: async (url) => {
      requests.push(url)
      return new Response(
        url.endsWith('SHASUMS256.txt') ? dist.sums : dist.archive,
      )
    },
  })
  assert.equal(requests.length, 2)
  const node = join(options.nodeOutDir, 'node')
  assert.equal(readFileSync(node, 'utf8'), 'first Node')
  // 旧 staged 文件不可绕过版本/校验；丢失 staged 目录也可从缓存重建。
  writeFileSync(node, 'stale Node')
  const offline = async () => assert.fail('cache hit must not access network')
  await stageNodeRuntime({ ...options, download: offline })
  assert.equal(readFileSync(node, 'utf8'), 'first Node')
  rmSync(options.nodeOutDir, { recursive: true })
  await stageNodeRuntime({ ...options, download: offline })
  assert.equal(readFileSync(node, 'utf8'), 'first Node')
  assert.equal(
    readdirSync(options.cacheDir).some((name) => name.startsWith('extract-')),
    false,
  )
})

test('version override replaces an already staged runtime', async (t) => {
  const { options, makeArchive } = fixture(t)
  for (const version of ['v22.21.1', 'v22.22.0']) {
    const dist = makeArchive(version, version)
    await stageNodeRuntime({
      ...options,
      version,
      download: async (url) =>
        new Response(url.endsWith('SHASUMS256.txt') ? dist.sums : dist.archive),
    })
    assert.equal(
      readFileSync(join(options.nodeOutDir, 'node'), 'utf8'),
      version,
    )
    assert.ok(existsSync(join(options.cacheDir, `${version}-SHASUMS256.txt`)))
  }
})

test('corrupt cached archive is rejected before replacing the staged runtime', async (t) => {
  const { options, makeArchive } = fixture(t)
  const dist = makeArchive(options.version, 'verified')
  mkdirSync(options.cacheDir)
  mkdirSync(options.nodeOutDir)
  writeFileSync(join(options.nodeOutDir, 'node'), 'previous runtime')
  writeFileSync(
    join(options.cacheDir, `${options.version}-SHASUMS256.txt`),
    dist.sums,
  )
  const archive = join(options.cacheDir, dist.file)
  writeFileSync(archive, 'incomplete archive')
  await assert.rejects(
    stageNodeRuntime({
      ...options,
      download: async () => assert.fail('must validate existing cache offline'),
    }),
    /SHA256 校验失败/,
  )
  assert.equal(existsSync(archive), false)
  assert.equal(
    readFileSync(join(options.nodeOutDir, 'node'), 'utf8'),
    'previous runtime',
  )
})

test('failed first download leaves no checksum or archive cache', async (t) => {
  const { options } = fixture(t)
  await assert.rejects(
    stageNodeRuntime({
      ...options,
      download: async () => {
        throw new Error('offline')
      },
    }),
    /首次打包需要联网/,
  )
  assert.deepEqual(readdirSync(options.cacheDir), [])
})

test('invalid versions and unsupported targets fail before network access', async (t) => {
  const { options } = fixture(t)
  const download = async () => assert.fail('invalid request must not download')
  await assert.rejects(
    stageNodeRuntime({ ...options, version: '../bad', download }),
    /Invalid Node version/,
  )
  await assert.rejects(
    stageNodeRuntime({ ...options, arch: 'unknown', download }),
    /未支持的打包平台/,
  )
})

for (const [platform, arch, target, extension] of [
  ['darwin', 'x64', 'darwin-x64', '.tar.gz'],
  ['linux', 'x64', 'linux-x64', '.tar.xz'],
  ['win32', 'x64', 'win-x64', '.zip'],
]) {
  test(`selects the official archive for ${platform}-${arch}`, async (t) => {
    const { options } = fixture(t)
    const file = `node-${options.version}-${target}${extension}`
    const requests = []
    await assert.rejects(
      stageNodeRuntime({
        ...options,
        platform,
        arch,
        download: async (url) => {
          requests.push(url)
          if (url.endsWith('SHASUMS256.txt'))
            return new Response(`${'a'.repeat(64)}  ${file}\n`)
          throw new Error('download deliberately blocked')
        },
      }),
      /无法下载/,
    )
    assert.equal(
      requests[1],
      `https://nodejs.org/dist/${options.version}/${file}`,
    )
  })
}
