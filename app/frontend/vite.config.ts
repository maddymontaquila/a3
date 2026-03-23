import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function getServiceTarget(serviceName: string): string | undefined {
  const name = serviceName.toUpperCase()
  return process.env[`API_${name}_HTTPS`]
    ?? process.env[`API_${name}_HTTP`]
}

const proxyTargets = {
  '/api/boston': getServiceTarget('boston'),
  '/api/nyc': getServiceTarget('nyc'),
  '/api/bart': getServiceTarget('bart'),
  '/api/advisor': getServiceTarget('advisor'),
}

const proxy = Object.fromEntries(
  Object.entries(proxyTargets).flatMap(([path, target]) =>
    target
      ? [[path, {
          target,
          changeOrigin: true,
          secure: false,
          rewrite: (requestPath: string) =>
            requestPath === path ? '/' : requestPath.slice(path.length),
        }]]
      : []
  )
)

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || '5173'),
    proxy,
  },
})
