"use client";

import { instrumentSerif } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";
import { CvIngest } from "@/components/cv/cv-ingest";

export function FirstRunHome() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 md:py-16">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> local-first · your machine
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 text-4xl leading-[1.05] text-landing md:text-5xl`}>
            Drop your CV. See who&apos;s hiring you in 60 seconds.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
            No account. Paste text or drop a .md / .txt file to start. A PDF needs an AI CLI in{" "}
            <a href="/config" className="text-foreground underline-offset-2 hover:underline">
              Config
            </a>{" "}
            first. The market scan is <span className="text-foreground">free</span>. You only spend tokens when you
            choose to score a role.
          </p>
          <div className="mt-7">
            <CvIngest />
          </div>
        </div>
      </section>
    </div>
  );
}
