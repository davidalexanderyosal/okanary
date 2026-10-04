import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/money/networth", label: "Net worth" },
  { to: "/money/goals", label: "Goals" },
  { to: "/money/plan", label: "Plan" },
  { to: "/budgets", label: "Budgets" },
];

/** Top segmented control shared by every page in the Money section. */
export function MoneyTabs() {
  return (
    <nav aria-label="Money" className="pt-3">
      <div className="grid grid-cols-4 gap-1 rounded-full bg-card p-1 shadow-sm" role="tablist">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            role="tab"
            className={({ isActive }) => `tap grid place-items-center rounded-full px-1 text-[13px] font-extrabold ${isActive ? "bg-accent text-accent-fg" : "text-muted active:bg-line/40"}`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
