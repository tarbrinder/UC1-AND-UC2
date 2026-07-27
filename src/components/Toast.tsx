import { createContext, useContext, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  show: (message: string, type?: ToastType, action?: ToastItem['action']) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />,
  info: <Info className="w-4 h-4 text-blue-500 shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0" />,
  error: <XCircle className="w-4 h-4 text-red-500 shrink-0" />,
};

const BORDER: Record<ToastType, string> = {
  success: 'border-green-100',
  info: 'border-blue-100',
  warning: 'border-orange-100',
  error: 'border-red-100',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback(
    (message: string, type: ToastType = 'info', action?: ToastItem['action']) => {
      const id = Math.random().toString(36).slice(2);
      setToasts(prev => [...prev, { id, message, type, action }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    },
    []
  );

  const dismiss = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {createPortal(
        <div role="region" aria-live="polite" aria-atomic="false" aria-label="Notifications" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center pointer-events-none">
          {toasts.map(t => (
            <div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto animate-toast-in flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium max-w-sm w-full bg-white ${BORDER[t.type]} text-gray-700`}
            >
              {ICONS[t.type]}
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button
                  onClick={t.action.onClick}
                  className="text-teal-600 font-semibold hover:underline whitespace-nowrap"
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(t.id)}
                className="ml-auto text-gray-400 hover:text-gray-600 shrink-0"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}
