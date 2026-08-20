"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

// Intent hues come from the semantic tokens in globals.css; the panel itself
// is a solid --sf-1 surface so the toast reads correctly over both the light
// staff shell and the dark member shell (docs/UI-RULES.md §1: no hardcoded
// polarity in shared components).
const COLORS: Record<ToastType, { hue: string }> = {
  success: { hue: "var(--hue-success)" },
  error:   { hue: "var(--hue-danger)" },
  warning: { hue: "var(--hue-warning)" },
  info:    { hue: "var(--hue-info)" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const Icon = ICONS[toast.type];
  const colors = COLORS[toast.type];

  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), toast.duration ?? 3500);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl max-w-sm w-full"
      style={{
        background: "var(--sf-1)",
        border: `1px solid color-mix(in srgb, ${colors.hue} 35%, var(--bd-default))`,
        animation: "slideUp 0.25s ease-out",
      }}
    >
      <Icon className="w-4 h-4 shrink-0" style={{ color: colors.hue }} />
      <p className="text-sm flex-1 leading-snug" style={{ color: "var(--tx-1)" }}>{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="transition-colors shrink-0"
        style={{ color: "var(--tx-3)" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--tx-2)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--tx-3)"; }}
        aria-label="Dismiss notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info", duration = 3500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-3), { id, type, message, duration }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container — bottom centre on mobile, top right on desktop */}
      <div
        className="fixed z-[100] flex flex-col gap-2 pointer-events-none"
        style={{
          bottom: "calc(env(safe-area-inset-bottom) + 96px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: "calc(100vw - 32px)",
          maxWidth: 380,
        }}
      >
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}
