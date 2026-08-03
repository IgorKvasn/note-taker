import type { ToastMessage } from "../hooks/useToasts";
import "./Toast.css";

interface ToastProps {
  toasts: ToastMessage[];
}

/** Transient, auto-dismissing toasts (e.g. copy confirmations). Distinct from
 * NotesPanel's persistent, manually-dismissed conflict toast, which has its
 * own lifecycle and stays untouched by this component. */
export function Toast({ toasts }: ToastProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.isExiting ? "toast-stack__toast toast-stack__toast--closing" : "toast-stack__toast"}
          role="status"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
