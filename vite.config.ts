import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiHandler } from './server/api.js'

function steamGuessApi(rootDir: string, apiKey: string, dbPath?: string, catalogDbPath?: string, adminToken?: string): Plugin {
  const handler = createApiHandler({ rootDir, steamApiKey: apiKey, dbPath, catalogDbPath, adminToken, allowAdminWithoutToken: true, writeRateLimit: 300, profileRateLimit: 60 })
  return {
    name: 'steamguess-api',
    configureServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      steamGuessApi(process.cwd(), env.STEAM_WEB_API_KEY ?? '', env.STEAMGUESS_DB_PATH || undefined, env.STEAMGUESS_CATALOG_DB_PATH || undefined, env.STEAMGUESS_ADMIN_TOKEN || undefined),
    ],
  }
})
