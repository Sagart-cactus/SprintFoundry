import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4311,
    proxy: {
      '/api': 'http://localhost:4310',
    },
  },
  base: '/v4/',
  build: {
    outDir: 'dist',
  },
})
