import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Icon } from "./components/Icons";
import { QuickAdd } from "./components/QuickAdd";
import { ToastProvider } from "./components/Toast";
import { useRefData } from "./lib/refdata";
import { Home } from "./pages/Home";
import { Goals } from "./pages/Goals";
import { Plan } from "./pages/Plan";
import { Budgets } from "./pages/Budgets";
import { Import } from "./pages/Import";
import { Raw } from "./pages/Raw";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Subscriptions } from "./pages/Subscriptions";
import { Transactions } from "./pages/Transactions";
import { Wants } from "./pages/Wants";

const NetWorth = lazy(() => import("./pages/NetWorth").then((m) => ({ default: m.NetWorth })));
const GoalDetail = lazy(() => import("./pages/GoalDetail").then((m) => ({ default: m.GoalDetail })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));

// Settings lives behind the gear on Home; the centre slot is the add button.
// "Money" covers every /money/* page plus /budgets (its fourth tab).
const inMoney = (path: string) => path === "/money" || path.startsWith("/money/") || path === "/budgets";
const tabs: { to: string; label: string; icon: string; active?: (path: string) => boolean }[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/transactions", label: "Activity", icon: "list" },
  { to: "/money/networth", label: "Money", icon: "money", active: inMoney },
  { to: "/reports", label: "Reports", icon: "bars" },
];

function Tab({ to, label, icon, active }: { to: string; label: string; icon: string; active?: (path: string) => boolean }) {
  const { pathname } = useLocation();
  return (
    <NavLink to={to} end className={({ isActive }) => `tap flex flex-col items-center justify-center gap-0.5 py-1 text-[10.5px] font-bold ${(active ? active(pathname) : isActive) ? "text-accent" : "text-muted"}`}>
      <Icon name={icon} className="h-[22px] w-[22px]" />
      {label}
    </NavLink>
  );
}

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
      <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+112px)]">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/money" element={<Navigate to="/money/networth" replace />} />
          <Route path="/money/networth" element={<Suspense fallback={null}><NetWorth /></Suspense>} />
          <Route path="/money/goals" element={<Goals />} />
          <Route path="/money/goals/:id" element={<Suspense fallback={null}><GoalDetail /></Suspense>} />
          <Route path="/money/plan" element={<Plan />} />
          <Route path="/reports" element={<Suspense fallback={null}><Reports /></Suspense>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/review" element={<Review />} />
          <Route path="/raw" element={<Raw />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/import" element={<Import />} />
          <Route path="/wants" element={<Wants />} />
        </Routes>
      </main>

      <nav
        aria-label="Sections"
        className="fixed inset-x-3 z-30 mx-auto max-w-[calc(28rem-1.5rem)] rounded-[30px] bg-card px-1.5 pb-2 pt-2 shadow-[0_4px_0_var(--edge),0_12px_24px_-10px_rgb(60_80_140/0.4)]"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
      >
        <div className="grid grid-cols-5 items-end">
          {tabs.slice(0, 2).map((t) => <Tab key={t.to} {...t} />)}
          <button
            aria-label="Add expense"
            onClick={() => setAdding(true)}
            className="-mt-7 mb-0.5 grid h-[54px] w-[54px] shrink-0 place-items-center justify-self-center rounded-full bg-sun text-sun-fg shadow-xl active:translate-y-[3px] active:shadow-none"
          >
            <Icon name="plus" className="h-7 w-7" strokeWidth={2.8} />
          </button>
          {tabs.slice(2).map((t) => <Tab key={t.to} {...t} />)}
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
