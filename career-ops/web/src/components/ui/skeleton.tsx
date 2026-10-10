import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("skeleton rounded-xl", className)} style={style} aria-hidden="true" />;
}
