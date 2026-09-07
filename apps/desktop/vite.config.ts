import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import MonacoEditorPlugin from 'vite-plugin-monaco-editor'

// vite-plugin-monaco-editor exports CJS with .default wrapper; resolve to the actual plugin function
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monacoEditorPlugin =
  (MonacoEditorPlugin as any).default ?? MonacoEditorPlugin

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
  },
})
