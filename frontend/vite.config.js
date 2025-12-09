import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/health': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/solve': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/progress': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/history': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/cancel': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/queue-status': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      },
      '/status': {
        target: 'http://localhost:80',
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})