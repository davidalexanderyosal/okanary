import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { QuickAdd } from "./components/QuickAdd";
import { ToastProvider } from "./components/Toast";
import { useRefData } from "./lib/refdata";
import { Home } from "./pages/Home";
import { Budgets } from "./pages/Budgets";
import { Raw } from "./pages/Raw";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Transactions } from "./pages/Transactions";

const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));

const tabs = [
  { to: "/", label: "Home", icon: "◉" },
  { to: "/transactions", label: "Activity", icon: "☰" },
  { to: "/budgets", label: "Budgets", icon: "◧" },
  { to: "/reports", label: "Reports", icon: "◔" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

function Shell() {
  const [adding, setAdding] = useState(false);
  const ref = useRefData();
  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener("okanary:quickadd", open);
    return () => window.removeEventListener("okanary:quickadd", open);
  }, []);
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+88px)]">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/reports" element={<Suspense fallback={null}><Reports /></Suspense>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/review" element={<Review />} />
          <Route path="/raw" element={<Raw />} />
        </Routes>
      </main>

      <button
        aria-label="Add expense"
        onClick={() => setAdding(true)}
        className="fixed right-5 z-40 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-4xl font-light leading-none text-accent-fg shadow-xl active:scale-95"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 76px)" }}
      >
        +
      </button>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 pb-safe backdrop-blur">
        <div className="mx-auto flex max-w-md">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end className={({ isActive }) => `tap flex flex-1 flex-col items-center justify-center py-1.5 text-[11px] ${isActive ? "text-accent" : "text-muted"}`}>
              <span className="text-lg leading-none" aria-hidden>{t.icon}</span>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <QuickAdd open={adding} onClose={() => setAdding(false)} groups={ref.groups} categories={ref.categories} usage={ref.usage} accounts={ref.accounts} />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </BrowserRouter>
  );
}
