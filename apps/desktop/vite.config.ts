import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: 'dist-frontend',
    emptyOutDir: true,
  },
})
