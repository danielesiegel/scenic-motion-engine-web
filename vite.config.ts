import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      // Allow serving assets/ and analysis/ which live outside root? They're inside root here.
      strict: true,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
