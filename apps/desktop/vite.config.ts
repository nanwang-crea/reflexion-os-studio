import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import MonacoEditorPlugin from 'vite-plugin-monaco-editor'

// vite-plugin-monaco-editor exports CJS with .default wrapper; resolve to the actual plugin function
const monacoEditorPlugin =
  (MonacoEditorPlugin as unknown as { default?: typeof MonacoEditorPlugin })
    .default ?? MonacoEditorPlugin

export default defineConfig({
  root: '.',
  plugins: [
    react(),
    monacoEditorPlugin({
      languageWorkers: [
        'editorWorkerService',
        'typescript',
        'json',
        'css',
        'html',
      ],
    }),
  ],
  build: {
    outDir: 'dist-frontend',
    emptyOutDir: true,
    // Monaco 及其语言服务是离线桌面编辑器的固定资产；当前主 chunk 约 5.1 MB。
    // 保留略高于实测基线的告警线，后续非预期增长到 5.5 MB 以上仍会暴露。
    chunkSizeWarningLimit: 5_500,
    rollupOptions: {
      onwarn(warning, warn) {
        // Zod 4.5.x 的纯注释位置会触发 Rollup INVALID_ANNOTATION；Rollup 本身
        // 会安全删除该注释。只过滤这个第三方已知告警，其余 warning 原样上报。
        if (
          warning.code === 'INVALID_ANNOTATION' &&
          warning.id?.includes('/node_modules/.pnpm/zod@')
        ) {
          return
        }
        warn(warning)
      },
    },
  },
})
