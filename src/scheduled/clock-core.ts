
import { RUN_DONE_OUTCOMES, RUN_FINE_OUTCOMES, runPad, runParseStarted } from "./run-core.js";
import type { RunRow } from "./run-core.js";
import { schedDue } from "./schedule-core.js";
import type { SchedParsed } from "./schedule-core.js";

export function runSlot(d: Date): string {
  return `${d.getFullYear()}-${runPad(d.getMonth() + 1)}-${runPad(d.getDate())} ${runPad(d.getHours())}:${runPad(d.getMinutes())}`;
}
export function runTookMs(s: string | null | undefined): number {
  let ms = 0;
  for (const [, n, u] of String(s || "").matchAll(/(\d+)\s*([hms])/g)) ms += Number(n) * (u === "h" ? 3600e3 : u === "m" ? 60e3 : 1e3);
  return ms;
}
export function runFailuresInARow(rows: RunRow[]): number {
  let count = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (RUN_DONE_OUTCOMES.includes(r.Outcome)) return count;
    if (r.Outcome === "running" || r.Outcome === "missed" || r.Outcome === "stopped" || r.Outcome === "skipped" || r.Outcome === "interrupted" || r.Occurrence === "Run now") continue;
    if (seen.has(r.Occurrence)) continue;
    seen.add(r.Occurrence);
    count++;
  }
  return count;
}
export type ClockDecision = { action: "run"; slot: Date } | { action: "missed"; slot: Date } | { action: "none" };
export function clockDecision({ rules, now, since, rows, catchUp = true }: { rules: SchedParsed | null | undefined; now: Date; since: Date | null; rows: RunRow[] | null | undefined; catchUp?: boolean }): ClockDecision {
  if (!rules || "error" in rules) return { action: "none" };
  const sched = (rows || []).filter((r) => runParseStarted(r.Occurrence));
  let lastSlot: Date | null = null;
  for (const r of sched) {
    const s = runParseStarted(r.Occurrence) as Date;
    if (!lastSlot || s.getTime() > lastSlot.getTime()) lastSlot = s;
  }
  const due = schedDue(rules, now, since, lastSlot, catchUp);
  if (due.run) return { action: "run", slot: due.run };
  if (due.missed) return { action: "missed", slot: due.missed };
  return { action: "none" };
}

export interface TaskSeen { schedule: string; paused: boolean; since: number }
export function taskSince(prev: TaskSeen | null | undefined, cur: { schedule: string; paused: boolean }, now: number, mtime: number | null | undefined, onSince: number, touchedAt = 0): { seen: TaskSeen; since: number } {
  let seen: TaskSeen;
  if (!prev) seen = { schedule: cur.schedule, paused: cur.paused, since: now };
  else if (prev.schedule === cur.schedule && prev.paused === cur.paused) seen = { schedule: prev.schedule, paused: prev.paused, since: prev.since };
  else seen = { schedule: cur.schedule, paused: cur.paused, since: mtime ? Math.min(now, mtime) : now };
  return { seen, since: Math.max(seen.since, onSince || 0, Math.min(touchedAt || 0, now)) };
}
export type ClockStep = ClockDecision | { action: "skipped"; slot: Date };
export function clockStep(x: { rules: SchedParsed | null | undefined; now: Date; since: Date | null; rows: RunRow[] | null | undefined; catchUp?: boolean }): ClockStep {
  const rows = x.rows || [];
  const d = clockDecision(x);
  if (runFailuresInARow(rows) < 3) return d;
  const lastSched = rows.find((r) => runParseStarted(r.Occurrence));
  if (d.action === "run" && !(lastSched && lastSched.Outcome === "skipped")) return { action: "skipped", slot: d.slot };
  return { action: "none" };
}
export function runNotifyKind(outcome: string, scheduled: boolean): "problem" | "fine" | null {
  if (!scheduled || outcome === "interrupted" || outcome === "stopped") return null;
  return RUN_FINE_OUTCOMES.includes(outcome) ? "fine" : "problem";
}
