#!/usr/bin/env node
// 把 TS Runtime 打包成单文件 ESM（bundle 掉 workspace 依赖），供桌面安装包
// 随包分发：打包产物不依赖 node_modules，只需 Node 运行时本身。
// 开发流程（pnpm dev / 冒烟测试）仍使用 tsc 输出的 apps/runtime/dist，
// 本脚本只在 prepare-package（tauri build 的 beforeBuildCommand）中调用。
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(
  repoRoot,
  'apps',
  'desktop',
  'src-tauri',
  'package-resources',
  'runtime',
)
const outFile = join(outDir, 'runtime.mjs')

await mkdir(outDir, { recursive: true })
await build({
  entryPoints: [join(repoRoot, 'apps', 'runtime', 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node: 内建模块（含 node:sqlite）保持外部引用，由随包 Node 运行时提供。
  external: ['node:*'],
  // 部分 CommonJS 依赖仍会动态 require Node 内建模块。ESM 单文件中为其
  // 提供 Node 原生 require，避免安装包 Runtime 在模块加载阶段直接退出。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      'const require = __createRequire(import.meta.url)',
    ].join('\n'),
  },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})

console.log(`runtime bundle written: ${outFile}`)
