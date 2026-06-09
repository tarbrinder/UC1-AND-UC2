import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // IndiaMART LLM gateway
      '/api/llm': {
        target: 'https://imllm.intermesh.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llm/, '/v1'),
      },
      // IndiaMART apps APIs (MCAT + ISQ)
      '/api/imimg': {
        target: 'https://apps.imimg.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/imimg/, ''),
      },
      // IndiaMART suggest API
      '/api/suggest': {
        target: 'https://suggest.imimg.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/suggest/, ''),
      },
      // IndiaMART mobile APIs (getISQs spec list)
      '/api/mimart': {
        target: 'https://m.indiamart.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/mimart/, ''),
      },
      // Buyer-insights enrichment webhook (n8n). DEBUG/DEMO: called directly,
      // raw (no proxy stripping) — we want to see everything for now.
      '/api/imworkflow': {
        target: 'https://imworkflow.intermesh.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/imworkflow/, ''),
      },
      // E (external enrichment): Befisc / Sign3 smartauth proxy — same-origin so the
      // browser dodges CORS and the authkey can stay server-side. The form calls
      // `/api/smartauth/<CODE>` (e.g. Profile-Advance C9S1); Vite forwards to smartauth.
      // Befisc/Sign3 endpoint CODES + keys arrive in Part C (set them in .env).
      '/api/smartauth': {
        target: 'https://prod.smartauth.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/smartauth/, ''),
      },
    },
  },
})
