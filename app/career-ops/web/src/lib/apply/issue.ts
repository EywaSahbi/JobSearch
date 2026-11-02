export type ApplyIssue = { level: "block" | "warn" | "info"; code: string; message: string; field?: string };

export type DriveStep = { turn: number; action: string; detail: string; thumb?: string; note?: string; refusal?: "submit-control" | "not-offered" | "gone" };
