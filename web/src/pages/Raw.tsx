import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useResource } from "../lib/data";

const BADGE: Record<string, string> = { ok: "text-savings", failed: "text-danger", received: "text-muted", dismissed: "text-muted" };

/** Everything that ever arrived by Apple Pay or email, parsed or not (spec §4.2: nothing is ever dropped). */
export function Raw() {
  const list = useResource("raw", api.rawList);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setBody((await api.rawGet(id)).payload ?? "");
  }
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/setup" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Auto-capture</Link>
      <h1 className="pb-2 text-2xl font-bold">Raw captures</h1>
      <div className="overflow-hidden rounded-3xl bg-card shadow-sm">
        {(list.data ?? []).length === 0 && <p className="p-5 text-center text-sm text-muted">Nothing captured yet.</p>}
        {(list.data ?? []).map((r) => (
          <div key={r.id} className="border-b border-line last:border-0">
            <button className="tap w-full px-4 py-2.5 text-left" onClick={() => void toggle(r.id)}>
              <span className="flex justify-between text-sm"><span className="font-medium">{r.source}</span><span className={BADGE[r.parse_status ?? ""] ?? ""}>{r.parse_status}</span></span>
              <span className="block truncate text-xs text-muted">{new Date(r.received_at).toLocaleString()} · {r.error ?? r.preview?.replace(/\s+/g, " ")}</span>
            </button>
            {open === r.id && <pre className="mx-4 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-bg p-2 text-xs">{body}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
