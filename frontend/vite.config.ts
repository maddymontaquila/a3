import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || '5173'),
    proxy: {
      '/api/boston': {
        target: 'http://localhost:5180',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/boston/, ''),
      },
      '/api/nyc': {
        target: 'http://localhost:5181',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nyc/, ''),
      },
      '/api/bart': {
        target: 'http://localhost:5182',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bart/, ''),
      },
      '/api/advisor': {
        target: 'http://localhost:5183',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/advisor/, ''),
      },
    },
  },
})
