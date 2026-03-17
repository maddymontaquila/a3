import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Aspire injects service URLs as env vars like services__api-boston__http__0
// These contain the full URL (e.g., http://localhost:56789)
const bostonApi = process.env.services__api_boston__http__0 || process.env['services__api-boston__http__0'] || 'http://localhost:5180'
const nycApi = process.env.services__api_nyc__http__0 || process.env['services__api-nyc__http__0'] || 'http://localhost:5181'
const bartApi = process.env.services__api_bart__http__0 || process.env['services__api-bart__http__0'] || 'http://localhost:5182'
const advisorApi = process.env.services__api_advisor__http__0 || process.env['services__api-advisor__http__0'] || 'http://localhost:5183'

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || '5173'),
    proxy: {
      '/api/boston': {
        target: bostonApi,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/boston/, ''),
      },
      '/api/nyc': {
        target: nycApi,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/nyc/, ''),
      },
      '/api/bart': {
        target: bartApi,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/bart/, ''),
      },
      '/api/advisor': {
        target: advisorApi,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/advisor/, ''),
      },
    },
  },
})
