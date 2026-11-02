export const CHANNELS = ["Email", "LinkedIn", "Phone", "Other"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PROFILE_CADENCE_KEYS = [
  "applied_first_days",
  "applied_subsequent_days",
  "applied_max_followups",
  "responded_initial_days",
  "responded_subsequent_days",
  "interview_thankyou_days",
] as const;
export type ProfileCadenceKey = (typeof PROFILE_CADENCE_KEYS)[number];

export type FollowupLogEntry = {
  num: number | null;
  appNum: number;
  date: string;
  company: string;
  role: string;
  channel: string;
  contact: string;
  notes: string;
};

export type SuggestedContact = { email: string; name: string | null };

export type CadenceEntry = {
  num: number;
  date: string;
  appliedDate: string;
  company: string;
  role: string;
  status: "applied" | "responded" | "interview";
  score: string;
  notes: string;
  reportPath: string | null;
  contacts: SuggestedContact[];
  daysSinceApplication: number;
  daysSinceLastFollowup: number | null;
  followupCount: number;
  followups: FollowupLogEntry[];
  urgency: Urgency;
  nextFollowupDate: string | null;
  nextOverride?: string | null;
  daysUntilNext: number | null;
};

export type CadenceMetadata = {
  analysisDate: string;
  totalTracked: number;
  actionable: number;
  overdue: number;
  urgent: number;
  cold: number;
  waiting: number;
};

export type Urgency = "urgent" | "overdue" | "waiting" | "cold";

export const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };

export function urgencyRank(u: string): number {
  return URGENCY_RANK[u as Urgency] ?? 9;
}

export function urgencyTone(u: string): "bad" | "warn" | "info" | "muted" {
  if (u === "urgent") return "bad";
  if (u === "overdue") return "warn";
  if (u === "waiting") return "info";
  return "muted";
}

export function followupStatusTone(status: string): "good" | "info" | "muted" {
  const s = status.toLowerCase();
  if (s.includes("interview")) return "good";
  if (s.includes("responded")) return "info";
  return "muted";
}

export function relativeDays(daysUntil: number): string {
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  if (daysUntil > 1) return `in ${daysUntil} days`;
  return daysUntil === -1 ? "1 day ago" : `${-daysUntil} days ago`;
}

export function daysHeatClass(days: number | null): string {
  if (days == null) return "text-faint";
  if (days >= 14) return "font-bold text-red-600 dark:text-red-400";
  if (days >= 7) return "font-bold text-amber-600 dark:text-amber-400";
  return "";
}

export function localISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isRealISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function oxfordJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
