"use client";

import { useApply } from "@/components/apply/apply-provider";
import { ApplyBackdrop } from "@/components/apply/apply-backdrop";

export function ApplyBackdropMount() {
  const a = useApply();
  if (a.status === "idle" || a.status === "error") return null;
  const intense = a.status === "opening" || a.status === "prefilling" || a.status === "filling";
  return <ApplyBackdrop image={a.shots[0]} intense={intense} />;
}
