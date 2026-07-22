import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file (if present locally)
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Proxy API Routes (matching vite.config.ts)
// ==========================================

// IndiaMART LLM gateway
app.use('/api/llm', createProxyMiddleware({
  target: 'https://imllm.intermesh.net',
  changeOrigin: true,
  pathRewrite: { '^/api/llm': '/v1' },
}));

// IndiaMART apps APIs (MCAT + ISQ)
app.use('/api/imimg', createProxyMiddleware({
  target: 'https://apps.imimg.com',
  changeOrigin: true,
  pathRewrite: { '^/api/imimg': '' },
}));

// IndiaMART suggest API
app.use('/api/suggest', createProxyMiddleware({
  target: 'https://suggest.imimg.com',
  changeOrigin: true,
  pathRewrite: { '^/api/suggest': '' },
}));

// IndiaMART mobile APIs (getISQs spec list)
app.use('/api/mimart', createProxyMiddleware({
  target: 'https://m.indiamart.com',
  changeOrigin: true,
  pathRewrite: { '^/api/mimart': '' },
}));

// Buyer-insights enrichment webhook (n8n).
app.use('/api/imworkflow', createProxyMiddleware({
  target: 'https://imworkflow.intermesh.net',
  changeOrigin: true,
  pathRewrite: { '^/api/imworkflow': '' },
  proxyTimeout: 600000, // 10 minutes timeout for n8n webhook
  timeout: 600000,
}));

// Befisc Profile-Advance (mobile → identity).
app.use('/api/smartauth', createProxyMiddleware({
  target: 'https://prod.smartauth.co',
  changeOrigin: true,
  pathRewrite: { '^/api/smartauth': '' },
  on: {
    proxyReq: (proxyReq, req, res) => {
      if (process.env.BEFISC_AUTHKEY) {
        proxyReq.setHeader('authkey', process.env.BEFISC_AUTHKEY);
      }
    }
  }
}));

// Sign3 Persona
app.use('/api/sign3', createProxyMiddleware({
  target: 'https://you.sign3.in',
  changeOrigin: true,
  pathRewrite: { '^/api/sign3': '' },
  on: {
    proxyReq: (proxyReq, req, res) => {
      if (process.env.SIGN3_BEARER) {
        proxyReq.setHeader('Authorization', `Bearer ${process.env.SIGN3_BEARER}`);
      }
    }
  }
}));

// Seller / entity web-verify crawler (OSINT)
app.use('/api/sellerverify', createProxyMiddleware({
  target: 'http://34.93.111.50',
  changeOrigin: true,
  pathRewrite: { '^/api/sellerverify': '' },
}));

// Firecrawl web search (World/OSINT)
app.use('/api/firecrawl', createProxyMiddleware({
  target: 'https://api.firecrawl.dev',
  changeOrigin: true,
  pathRewrite: { '^/api/firecrawl': '' },
  on: {
    proxyReq: (proxyReq, req, res) => {
      if (process.env.FIRECRAWL_API_KEY) {
        proxyReq.setHeader('Authorization', `Bearer ${process.env.FIRECRAWL_API_KEY}`);
      }
    }
  }
}));

// ==========================================
// Static Files & Catch-all route
// ==========================================

// Serve static files from the React build directory
app.use(express.static(path.join(__dirname, 'dist')));

// Catch-all route to serve index.html for client-side routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Production Express server running on port ${PORT}`);
});
