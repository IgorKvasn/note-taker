import { useCallback, useEffect, useRef, useState } from "react";

const TOAST_DURATION_MS = 2000;

/** Mirrors the `--motion-base` CSS custom property (styles.css) that drives the toast's exit
 * transition. Kept as a plain constant, like TOAST_DURATION_MS, rather than read from CSS. */
const EXIT_DURATION_MS = 180;

export interface ToastMessage {
  id: number;
  message: string;
  isExiting: boolean;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      for (const timer of timersAtMount.values()) {
        clearTimeout(timer);
      }
      timersAtMount.clear();
    };
  }, []);

  const showToast = useCallback((message: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, isExiting: false }]);

    const displayTimer = setTimeout(() => {
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, isExiting: true } : toast)));

      const exitTimer = setTimeout(() => {
        timers.current.delete(id);
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, EXIT_DURATION_MS);
      timers.current.set(id, exitTimer);
    }, TOAST_DURATION_MS);
    timers.current.set(id, displayTimer);
  }, []);

  return { toasts, showToast };
}
