import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Function form so we can loadEnv — the '' prefix loads ALL vars (incl. non-VITE_ secrets
// like BEFISC_AUTHKEY / SIGN3_BEARER) into vite.config ONLY. The proxy injects those auth
// headers server-side, so the credentials never enter the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // OFFLINE build (`vite build --mode offline`, via `npm run build:offline`): emit ONE self-contained ES-module chunk
  // (inlineDynamicImports → no import()/no external fetch) + one CSS + inline assets. The inliner keeps it as an INLINE
  // `<script type="module">` placed at end-of-body: a fully-inlined module has no fetch, so it runs from file:// (only
  // module scripts with a src/imports are CORS-blocked there), and body-end placement keeps #root ready. (IIFE was tried
  // and rolldown's IIFE output rendered nothing for this React-19 app — reverted.) Normal build/dev is untouched.
  const offline = mode === 'offline'
  return {
    plugins: [react()],
    ...(offline ? {
      build: {
        target: 'es2019',
        modulePreload: false,
        cssCodeSplit: false,
        assetsInlineLimit: 100_000_000,
        rollupOptions: {
          output: { inlineDynamicImports: true, entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' },
        },
      },
    } : {}),
    server: {
      proxy: {
        // IndiaMART LLM gateway — buyer-CARD path (distinct prefix so it never collides with /api/llm's
        // startsWith match). Injects the buyer-card key SERVER-SIDE (env.RFQ_BUYERCARD_KEY; legacy VITE_ name as
        // fallback) so the key never enters the browser bundle. Runs flash-lite. Prod must replicate this injection.
        '/api/cardllm': {
          target: 'https://imllm.intermesh.net',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cardllm/, '/v1'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const cardKey = env.RFQ_BUYERCARD_KEY || env.VITE_RFQ_BUYERCARD_KEY
              if (cardKey) proxyReq.setHeader('Authorization', `Bearer ${cardKey}`)
            })
          },
        },
        // IndiaMART LLM gateway — FORM path. Injects the RFQ form key SERVER-SIDE (env.RFQ_LLM_KEY; legacy
        // VITE_RFQ_LLM_KEY as fallback during transition) so the key never enters the browser bundle. Prod must
        // replicate this same injection (same model as Befisc/Sign3/Firecrawl below).
        '/api/llm': {
          target: 'https://imllm.intermesh.net',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/llm/, '/v1'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const formKey = env.RFQ_LLM_KEY || env.VITE_RFQ_LLM_KEY
              if (formKey) proxyReq.setHeader('Authorization', `Bearer ${formKey}`)
            })
          },
        },
        // Curated seller search (windmill "curated_seller_search_v6_7"). The form POSTs to `/api/sellersearch`;
        // the proxy forwards to the windmill run URL. Auth (`ak`) rides in the request body — no header injection.
        '/api/sellersearch': {
          target: 'https://windmill.intermesh.net',
          changeOrigin: true,
          rewrite: () => '/api/r/indiamart-workspace/curated_seller_search_v6_7-golive',
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
          proxyTimeout: 600000,
          timeout: 600000,
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
        // `/api/sellerverify/api/v2/seller/verify` (+ /status/<job>); the proxy forwards to the scraper host and
        // injects X-Gemini-Key SERVER-SIDE (env.LLM_GATEWAY_KEY; legacy VITE_LLM_KEY as fallback) so the Gemini
        // key never enters the browser bundle (audit P0 — it used to be read client-side).
        '/api/sellerverify': {
          target: 'http://34.93.111.50',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/sellerverify/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const gkey = env.LLM_GATEWAY_KEY || env.VITE_LLM_KEY
              if (gkey) proxyReq.setHeader('X-Gemini-Key', gkey)
            })
          },
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
