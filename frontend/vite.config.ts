import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Aspire injects service URLs as env vars
const bostonApi = process.env['services__api-boston__http__0'] || 'http://localhost:5180'
const nycApi = process.env['services__api-nyc__http__0'] || 'http://localhost:5181'
const bartApi = process.env['services__api-bart__http__0'] || 'http://localhost:5182'
const advisorApi = process.env['services__api-advisor__http__0'] || 'http://localhost:5183'

console.log('[vite] Boston:', bostonApi, '| NYC:', nycApi, '| BART:', bartApi, '| Advisor:', advisorApi)

export default defineConfig({
  plugins: [react()],
  define: {
    // Inject API URLs as global constants at build time
    __API_BOSTON__: JSON.stringify(bostonApi),
    __API_NYC__: JSON.stringify(nycApi),
    __API_BART__: JSON.stringify(bartApi),
    __API_ADVISOR__: JSON.stringify(advisorApi),
  },
  server: {
    port: parseInt(process.env.PORT || '5173'),
  },
})
