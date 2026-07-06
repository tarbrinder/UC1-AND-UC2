
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ToastProvider } from './components/Toast';
import { maybeHydrateOffline } from './lib/offlineSnapshot';

// P4: if this is a downloaded offline HTML (window.__EMBEDDED_PULL present), seed the module state from the baked-in
// snapshot BEFORE React renders — so the dashboard hydrates from captured data with no network/LLM. No-op otherwise.
maybeHydrateOffline();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
