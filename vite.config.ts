import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/vy-monitor/',
  build: {
    outDir: 'docs'
  },
  server: {
    proxy: {
      '/api-mainnet': {
        target: 'https://api.valinity.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-mainnet/, ''),
      },
      '/api-testnet': {
        target: 'http://localhost:9800',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-testnet/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('Accept-Encoding');
          });
        }
      }
    }
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
})
