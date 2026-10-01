import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface ToastData { msg: string; action?: { label: string; run: () => void } }
const Ctx = createContext<(t: ToastData) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<ToastData | null>(null);
  const timer = useRef<number>();
  const show = useCallback((d: ToastData) => {
    setT(d);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), 5000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {t && (
        <div className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4" style={{ bottom: "calc(env(safe-area-inset-bottom) + 156px)" }}>
          <div className="pointer-events-auto flex min-h-11 items-center gap-3 rounded-full bg-fg px-5 text-sm text-bg shadow-lg" role="status">
            <span>{t.msg}</span>
            {t.action && (
              <button
                className="tap font-semibold underline"
                onClick={() => {
                  t.action!.run();
                  setT(null);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
