
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ToastProvider } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { maybeHydrateOffline } from './lib/offlineSnapshot';
import { captureError } from './utils/errorMonitoring';
import { emit } from './lib/emit';

// P4: if this is a downloaded offline HTML (window.__EMBEDDED_PULL present), seed the module state from the baked-in
// snapshot BEFORE React renders — so the dashboard hydrates from captured data with no network/LLM. No-op otherwise.
maybeHydrateOffline();

// Fixes P1-116: async failures (outside React render) had no handler and no telemetry. Record them globally.
window.addEventListener('error', (e) => { captureError('NETWORK_ERROR', e.message || 'window.error', e.filename); emit('rfq_window_error', { message: String(e.message || '').slice(0, 160) }); });
window.addEventListener('unhandledrejection', (e) => { const m = e.reason instanceof Error ? e.reason.message : String(e.reason); captureError('NETWORK_ERROR', m, 'unhandledrejection'); emit('rfq_unhandled_rejection', { message: m.slice(0, 160) }); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
