import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
import { useToast } from "../components/Toast";

function Copy({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <button className="tap rounded-xl border border-line px-3 text-sm font-medium" onClick={() => void navigator.clipboard.writeText(text).then(() => toast({ msg: `${label} copied` }))}>Copy</button>
  );
}

export function Setup() {
  const toast = useToast();
  const info = useResource("setup", api.setup);
  const [state, setState] = useState<PushState>("off");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void pushState().then(setState); }, [info.data]);
  const s = info.data;
  const endpoint = `${window.location.origin}${s?.ingest_path ?? "/api/ingest/applepay"}`;

  async function togglePush() {
    setBusy(true);
    try {
      if (state === "on") await disablePush();
      else await enablePush(s!.push.public_key!);
      setState(await pushState());
      invalidateAll();
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }

  const step = "mb-3 rounded-2xl bg-bg p-3 text-sm";
  const mono = "break-all rounded-lg bg-card px-2 py-1 font-mono text-xs";
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/settings" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Settings</Link>
      <h1 className="pb-2 text-2xl font-bold">Auto-capture setup</h1>

      <section className="rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">Apple Pay Shortcut</h2>
        {s && !s.token && (
          <div className={step}>No token yet. <button className="tap font-semibold text-accent" onClick={() => void api.rotateToken().then(invalidateAll)}>Generate one</button></div>
        )}
        {s?.token && (
          <>
            <div className={step}>
              <p className="pb-1 font-semibold">URL</p>
              <div className="flex items-center gap-2"><code className={mono}>{endpoint}</code><Copy text={endpoint} label="URL" /></div>
              <p className="pb-1 pt-3 font-semibold">Token</p>
              <div className="flex items-center gap-2">
                <code className={mono}>{reveal ? s.token : "•".repeat(24)}</code>
                <button className="tap rounded-xl border border-line px-3 text-sm" onClick={() => setReveal((r) => !r)}>{reveal ? "Hide" : "Show"}</button>
                <Copy text={s.token} label="Token" />
              </div>
              <button className="tap mt-2 text-sm text-danger" onClick={() => window.confirm("Rotate the token? Your Shortcut stops working until you paste the new one.") && void api.rotateToken().then(() => { invalidateAll(); setReveal(true); })}>Rotate token</button>
              <p className="pt-1 text-xs text-muted">{s.last_applepay_at ? `Last capture received ${new Date(s.last_applepay_at).toLocaleString()}` : "No capture received yet."}</p>
            </div>
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>Open <b>Shortcuts → Automation → +</b> and pick <b>Transaction</b> (Wallet). Needs iOS 17+.</li>
              <li>Choose your DBS and Citi cards. Set <b>Run Immediately</b> (not "Run after confirmation").</li>
              <li>Add the action <b>Get Contents of URL</b> and set:
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>URL: the URL above</li>
                  <li>Method: <b>POST</b></li>
                  <li>Headers: <code>Authorization</code> = <code>Bearer &lt;token&gt;</code> and <code>Content-Type</code> = <code>application/json</code></li>
                  <li>Request Body: <b>JSON</b> with four fields:
                    <div className="mt-1 space-y-0.5 font-mono text-xs">
                      <div>amount → <i>Amount</i> (from Shortcut Input)</div>
                      <div>merchant → <i>Merchant</i></div>
                      <div>card → <i>Card or Pass</i> (its name)</div>
                      <div>ts → <i>Format Date</i> of <i>Current Date</i>, format <b>ISO 8601</b></div>
                    </div>
                  </li>
                </ul>
              </li>
              <li>In <Link to="/settings" className="text-accent underline">Settings</Link>, set each card's <b>Apple Wallet card name</b> to exactly what Wallet shows, so taps land on the right account.</li>
              <li>Tap a card at a shop. The purchase appears here (dotted = pending) and you get a notification.</li>
            </ol>
            <p className="mt-3 text-xs text-muted">Apple Pay only triggers for in-store contactless taps. Online, in-app and recurring charges arrive by email (a later phase). Exclude <code>/api/ingest/applepay</code> from Cloudflare Access so the Shortcut can reach it with the token.</p>
          </>
        )}
      </section>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">Bank alert emails</h2>
        {(["dbs", "citi"] as const).map((b) => {
          const st = s?.email.banks[b];
          return (
            <p key={b} className="flex justify-between py-1 text-sm">
              <span className="font-medium">{b.toUpperCase()}</span>
              <span className={st ? "" : "text-muted"}>{st ? `last email ${new Date(st.last_at).toLocaleString()}${st.failed ? ` · ${st.failed} unreadable` : ""}` : "none received yet"}</span>
            </p>
          );
        })}
        {s && !s.email.forward_configured && <p className="pt-1 text-xs text-muted">Set the <code>FORWARD_TO</code> variable so Gmail's forwarding-verification mail reaches you (see README).</p>}
        <Link to="/raw" className="tap mt-1 flex items-center justify-between text-sm font-medium text-accent"><span>Captured emails &amp; raw log</span><span>›</span></Link>
      </section>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">Notifications</h2>
        {state === "needs-install" && <p className="pb-2 text-sm">On iPhone, notifications only work after <b>Add to Home Screen</b> (Safari → Share). Open Okanary from the Home Screen icon, then come back here.</p>}
        {state === "unsupported" && <p className="pb-2 text-sm text-muted">This browser doesn't support push notifications.</p>}
        {state === "denied" && <p className="pb-2 text-sm text-danger">Notifications are blocked. Enable them in iOS Settings → Notifications → Okanary.</p>}
        {s && !s.push.configured && <p className="pb-2 text-sm text-muted">The server has no VAPID keys yet (see README: <code>npm run vapid</code>).</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || !s?.push.configured || state === "unsupported" || state === "needs-install" || state === "denied"} onClick={() => void togglePush()}
            className="tap rounded-xl bg-accent px-4 font-semibold text-accent-fg disabled:opacity-40">{state === "on" ? "Turn off on this device" : "Enable on this device"}</button>
          <button disabled={!s?.push.configured || state !== "on"} onClick={() => void api.pushTest().then((r) => toast({ msg: r.delivered ? "Test sent" : "Nothing delivered" }))}
            className="tap rounded-xl border border-line px-4 disabled:opacity-40">Send test</button>
        </div>
        <p className="pb-1 pt-4 text-sm font-semibold">Budget alerts</p>
        <p className="pb-2 text-xs text-muted">A notification when a budget reaches these percentages (once per month each).</p>
        <div className="flex flex-wrap gap-2">
          {[25, 50, 75, 80, 90, 100].map((t) => {
            const on = (s?.alerts.thresholds ?? []).includes(t);
            return (
              <button key={t} aria-pressed={on} onClick={() => { const cur = new Set(s?.alerts.thresholds ?? []); on ? cur.delete(t) : cur.add(t); void api.putSettings({ alert_thresholds: [...cur].sort((a, b) => a - b) }).then(invalidateAll); }}
                className={`tap rounded-full border px-4 text-sm ${on ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}>{t}%</button>
            );
          })}
        </div>
        <label className="tap mt-3 flex items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={s?.push.post_purchase ?? true} onChange={(e) => void api.putSettings({ push_post_purchase: e.target.checked }).then(invalidateAll)} />
          Notify after each auto-captured purchase
        </label>
        <label className="tap flex items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={s?.push.weekly_digest ?? true} onChange={(e) => void api.putSettings({ push_weekly_digest: e.target.checked }).then(invalidateAll)} />
          Sunday-evening weekly digest
        </label>
      </section>
    </div>
  );
}
