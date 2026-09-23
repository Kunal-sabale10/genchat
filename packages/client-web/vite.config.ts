import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@genchat/client-crypto': path.resolve(import.meta.dirname, '../client-crypto/src'),
      '@genchat/client-db': path.resolve(import.meta.dirname, '../client-db/src'),
      '@nozbe/watermelondb': path.resolve(import.meta.dirname, '../client-db/node_modules/@nozbe/watermelondb'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/chat.v1.': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/auth/': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/features': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/users/': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/dev-token': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8081',
        ws: true,
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/v1/media': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/presign': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lucide-react')) {
              return 'vendor-icons'
            }
            if (id.includes('@protobuf-ts')) {
              return 'vendor-protobuf'
            }
            if (id.includes('react-router') || id.includes('react-router-dom')) {
              return 'vendor-router'
            }
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react'
            }
          }
        },
      },
    },
  },
})
