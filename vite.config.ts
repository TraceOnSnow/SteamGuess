import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiHandler } from './server/api.js'

/** Serves the same HTTP API in `npm run dev` as the production server. */
function steamGuessApi(rootDir: string, dbPath?: string): Plugin {
  const handler = createApiHandler({ rootDir, dbPath, writeRateLimit: 300 })
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
    plugins: [react(), steamGuessApi(process.cwd(), env.STEAMGUESS_DB_PATH || undefined)],
  }
})
