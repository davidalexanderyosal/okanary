import { useEffect, type ReactNode } from "react";

/** Bottom sheet that respects the home-indicator safe area. */
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Close" className="absolute inset-0 bg-[rgb(20_26_60/0.55)]" onClick={onClose} />
      <div className="relative max-h-[94dvh] overflow-y-auto rounded-t-[28px] border-t-2 border-dashed border-lilac bg-card pb-safe shadow-2xl">
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-line" />
        {title && <h2 className="px-5 pt-3 text-base font-extrabold">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
