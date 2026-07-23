import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from '../utils/errorMonitoring';
import { emit } from '../lib/emit';

// Fixes audit P1-116: a render-time throw anywhere used to white-screen the whole app with no fallback and no
// telemetry. This boundary catches it, records it (captureError + emit), and shows a friendly Retry card.

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureError('VALIDATION_ERROR', error.message, info.componentStack ?? undefined);
    emit('rfq_render_error', { message: error.message.slice(0, 160) });
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="min-h-screen flex items-center justify-center p-6 bg-gray-50 text-center">
          <div className="max-w-sm">
            <p className="text-lg font-bold text-gray-800">Something went wrong</p>
            <p className="text-sm text-gray-500 mt-2">The page hit an unexpected error. You can retry — your connection and data are unaffected.</p>
            <button
              type="button"
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="mt-4 px-5 py-2.5 rounded-lg bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
