import { useCallback, useEffect, useRef, useState } from "react";

const TOAST_DURATION_MS = 2000;

export interface ToastMessage {
  id: number;
  message: string;
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
    setToasts((current) => [...current, { id, message }]);

    const timer = setTimeout(() => {
      timers.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    timers.current.set(id, timer);
  }, []);

  return { toasts, showToast };
}
