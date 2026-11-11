
import { RUN_DONE_OUTCOMES, RUN_FINE_OUTCOMES, runPad, runParseStarted } from "./run-core.js";
import type { RunRow } from "./run-core.js";
import { NO_CATCH_UP_GRACE_MS, schedDue, schedNext } from "./schedule-core.js";
import type { SchedParsed } from "./schedule-core.js";

export const RUN_RETRYABLE = ["failed", "wrote nothing", "timed out", "interrupted"];
export function runSlot(d: Date): string {
  return `${d.getFullYear()}-${runPad(d.getMonth() + 1)}-${runPad(d.getDate())} ${runPad(d.getHours())}:${runPad(d.getMinutes())}`;
}
export function runTookMs(s: string | null | undefined): number {
  let ms = 0;
  for (const [, n, u] of String(s || "").matchAll(/(\d+)\s*([hms])/g)) ms += Number(n) * (u === "h" ? 3600e3 : u === "m" ? 60e3 : 1e3);
  return ms;
}
export function runFailuresInARow(rows: RunRow[], newestFinished = false): number {
  let count = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (RUN_DONE_OUTCOMES.includes(r.Outcome)) return count;
    if (r.Outcome === "running" || r.Outcome === "missed" || r.Outcome === "stopped" || r.Outcome === "skipped" || r.Outcome === "interrupted" || r.Occurrence === "Run now") continue;
    if (seen.has(r.Occurrence)) continue;
    const newest = seen.size === 0;
    seen.add(r.Occurrence);
    const tries = rows.filter((x) => x.Occurrence === r.Occurrence);
    const finished = !newest || newestFinished || tries.length >= 2 || tries.some((x) => Number(x.Attempt) >= 2 || !RUN_RETRYABLE.includes(x.Outcome));
    if (finished) count++;
  }
  return count;
}
export type ClockDecision = { action: "run"; slot: Date; attempt: 1 | 2 } | { action: "missed"; slot: Date } | { action: "none" };
export function clockDecision({ rules, now, since, rows, retryDelayMs = 5 * 60e3, catchUp = true, retry = true }: { rules: SchedParsed | null | undefined; now: Date; since: Date | null; rows: RunRow[] | null | undefined; retryDelayMs?: number; catchUp?: boolean; retry?: boolean }): ClockDecision {
  if (!rules || "error" in rules) return { action: "none" };
  const sched = (rows || []).filter((r) => runParseStarted(r.Occurrence));
  const latestRow = sched[0];
  if (retry && latestRow && latestRow.Outcome !== "running") {
    const slot = runParseStarted(latestRow.Occurrence) as Date;
    const tries = sched.filter((r) => r.Occurrence === latestRow.Occurrence);
    const done = tries.length >= 2 || tries.some((r) => Number(r.Attempt) >= 2 || !RUN_RETRYABLE.includes(r.Outcome));
    if (!done && (!since || slot.getTime() >= since.getTime())) {
      const next = schedNext(rules, slot);
      const interval = next ? next.getTime() - slot.getTime() : 24 * 3600e3;
      const started = runParseStarted(latestRow.Started);
      const endedAt = (started ? started.getTime() : 0) + runTookMs(latestRow.Took);
      const wait = latestRow.Outcome === "interrupted" ? 0 : retryDelayMs;
      const late = now.getTime() - slot.getTime();
      const fresh = catchUp ? late < interval / 2 : late <= NO_CATCH_UP_GRACE_MS;
      if (fresh && now.getTime() >= endedAt + wait && (!next || now.getTime() < next.getTime())) return { action: "run", slot, attempt: 2 };
    }
  }
  let lastSlot: Date | null = null;
  for (const r of sched) {
    const s = runParseStarted(r.Occurrence) as Date;
    if (!lastSlot || s.getTime() > lastSlot.getTime()) lastSlot = s;
  }
  const due = schedDue(rules, now, since, lastSlot, catchUp);
  if (due.run) return { action: "run", slot: due.run, attempt: 1 };
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
export function clockStep(x: { rules: SchedParsed | null | undefined; now: Date; since: Date | null; rows: RunRow[] | null | undefined; retryDelayMs?: number; catchUp?: boolean; retry?: boolean }): ClockStep {
  const rows = x.rows || [];
  const d = clockDecision(x);
  const retrying = d.action === "run" && d.attempt === 2;
  if (runFailuresInARow(rows, !retrying) < 3) return d;
  const lastSched = rows.find((r) => runParseStarted(r.Occurrence));
  if (d.action === "run" && d.attempt === 1 && !(lastSched && lastSched.Outcome === "skipped")) return { action: "skipped", slot: d.slot };
  return { action: "none" };
}
export function runNotifyKind(outcome: string, scheduled: boolean): "problem" | "fine" | null {
  if (!scheduled || outcome === "interrupted" || outcome === "stopped") return null;
  return RUN_FINE_OUTCOMES.includes(outcome) ? "fine" : "problem";
}
