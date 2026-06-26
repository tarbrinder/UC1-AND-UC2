import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Function form so we can loadEnv — the '' prefix loads ALL vars (incl. non-VITE_ secrets
// like BEFISC_AUTHKEY / SIGN3_BEARER) into vite.config ONLY. The proxy injects those auth
// headers server-side, so the credentials never enter the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
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
        // Befisc Profile-Advance (mobile → identity). The form calls `/api/smartauth/<CODE>`
        // (e.g. Profile-Advance C9S1); the proxy forwards to smartauth and injects the authkey
        // SERVER-SIDE (from env.BEFISC_AUTHKEY) so the key never enters the browser bundle.
        '/api/smartauth': {
          target: 'https://prod.smartauth.co',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/smartauth/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.BEFISC_AUTHKEY) proxyReq.setHeader('authkey', env.BEFISC_AUTHKEY)
            })
          },
        },
        // Sign3 Persona (mobile → digital footprint / breach / operator). The form calls
        // `/api/sign3/v1/persona`; the proxy forwards to you.sign3.in and injects the Bearer
        // SERVER-SIDE (from env.SIGN3_BEARER).
        '/api/sign3': {
          target: 'https://you.sign3.in',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/sign3/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.SIGN3_BEARER) proxyReq.setHeader('Authorization', `Bearer ${env.SIGN3_BEARER}`)
            })
          },
        },
        // Seller / entity web-verify crawler (OSINT). FRONTEND-only async job: the form calls
        // `/api/sellerverify/api/v2/seller/verify` (+ /status/<job>); the proxy forwards to the scraper host.
        // The X-Gemini-Key is sent browser-side (debug mode) — no server-side injection needed.
        '/api/sellerverify': {
          target: 'http://34.93.111.50',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/sellerverify/, ''),
        },
        // Firecrawl web search (REAL World/OSINT). The form calls `/api/firecrawl/v2/search`; the proxy
        // forwards to api.firecrawl.dev and injects the Bearer SERVER-SIDE (from env.FIRECRAWL_API_KEY)
        // so the key never enters the browser bundle.
        '/api/firecrawl': {
          target: 'https://api.firecrawl.dev',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/firecrawl/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.FIRECRAWL_API_KEY) proxyReq.setHeader('Authorization', `Bearer ${env.FIRECRAWL_API_KEY}`)
            })
          },
        },
      },
    },
  }
})
