"use client";

import { useEffect, useState } from "react";
import { progressModel } from "@/lib/analytics/view-model.mjs";

export function FunnelRates() {
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [model, setModel] = useState<ReturnType<typeof progressModel> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        const m = progressModel(d?.stats ?? null);
        setModel(m);
        setState(m.available ? "ready" : "unavailable");
      })
      .catch(() => alive && setState("unavailable"));
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") {
    return (
      <section className="mt-10">
        <h2 className="font-display text-lg text-landing">Conversion</h2>
        <div className="mt-4 grid gap-3" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="h-9 w-full animate-pulse rounded-md bg-muted/25"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (!model || (state === "unavailable" && model.reason !== "no-data")) return null;

  if (state === "unavailable") {
    return (
      <section className="mt-10">
        <h2 className="font-display text-lg text-landing">Conversion</h2>
        <p className="mt-3 rounded-2xl border border-dashed border-border bg-surface/30 px-5 py-6 text-sm text-muted">
          Nothing to convert yet — these rates come from applications you have
          sent. Apply to a role and the funnel fills in here.
        </p>
      </section>
    );
  }

  const { stages, rates } = model.funnel;
  const top = Math.max(1, ...stages.map((s) => s.value));

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-lg text-landing">Conversion</h2>
        <p className="text-xs text-faint">
          Cumulative — reaching a stage counts every stage before it, matching{" "}
          <code className="text-muted">stats.mjs</code>
        </p>
      </div>

      {model.provisional && (
        <p className="mt-2 text-xs text-muted">
          Small sample so far — these rates will move a lot with each new outcome.
        </p>
      )}

      <div className="mt-4 grid gap-2.5">
        {stages.map((s) => (
          <div key={s.key} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm text-muted">{s.label}</span>
            <div className="h-4 flex-1 overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-brand/70" style={{ width: `${(s.value / top) * 100}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-sm tabular-nums">{s.value}</span>
          </div>
        ))}
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3">
        {rates.map((r) => (
          <div key={r.key} className="rounded-xl border border-border bg-surface/40 px-3.5 py-3">
            <dt className="text-xs text-muted">{r.label}</dt>
            <dd className="mt-0.5 text-xl tabular-nums text-foreground">
              {r.value === null ? <span className="text-faint">—</span> : `${r.value}%`}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
