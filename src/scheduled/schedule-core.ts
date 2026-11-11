
export const SCHED_DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SCHED_DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type SchedTime = [number, number];
export type SchedRules =
  | { kind: "interval"; minutes: number }
  | { kind: "once"; date: [number, number, number]; times: SchedTime[] }
  | { kind: "monthly"; times: SchedTime[] }
  | { kind: "days"; days: Set<number>; times: SchedTime[] };
export type SchedParsed = SchedRules | { error: string };

export function isSchedError(r: SchedParsed | null | undefined): r is { error: string } | null | undefined {
  return !r || "error" in r;
}

function schedParseTime(tok: string): SchedTime | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(tok.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  const ap = m[3];
  if (!ap && m[2] == null) return null;
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "am" && h === 12) h = 0;
    if (ap === "pm" && h !== 12) h += 12;
  } else if (h > 23) return null;
  return [h, min];
}
function schedParseTimes(text: string): SchedTime[] | null {
  const parts = text.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  if (!parts.length) return null;
  const times: SchedTime[] = [];
  for (const p of parts) {
    const t = schedParseTime(p);
    if (!t) return null;
    if (!times.some((x) => x[0] === t[0] && x[1] === t[1])) times.push(t);
  }
  return times.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
}
function schedParseDays(text: string): Set<number> | null {
  const words = text.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  if (!words.length) return null;
  const days = new Set<number>();
  for (const w0 of words) {
    const w = w0.replace(/s$/, "");
    const i = SCHED_DAY_NAMES.findIndex((d) => d === w || d.slice(0, 3) === w);
    if (i < 0) return null;
    days.add(i);
  }
  return days;
}
export function schedParse(raw: unknown): SchedParsed {
  const text = typeof raw === "string" ? raw : raw == null ? "" : typeof raw === "number" ? String(raw) : "";
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { error: "No schedule set" };
  let m = /^every (\d+ )?(hour|hours|minute|minutes)$/.exec(s);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    const minutes = m[2].startsWith("hour") ? n * 60 : n;
    if (minutes < 15) return { error: "Every-N-minutes schedules must be at least 15 minutes apart" };
    if (minutes > 24 * 60 || (24 * 60) % minutes !== 0) return { error: "An interval must divide the day evenly (every 15, 20, 30 minutes, or 1, 2, 3, 4, 6, 8, 12 hours)" };
    return { kind: "interval", minutes };
  }
  m = /^once (?:on )?(\d{4})-(\d{1,2})-(\d{1,2}),? (?:at )?(.+)$/.exec(s);
  if (m) {
    const t = schedParseTime(m[4]);
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    const day = new Date(y, mo, d);
    if (!t || day.getFullYear() !== y || day.getMonth() !== mo || day.getDate() !== d) return { error: `Can't read the date or time in "${text}"` };
    return { kind: "once", date: [y, mo, d], times: [t] };
  }
  m = /^(?:the )?first of (?:the|each|every) month (?:at )?(.+)$/.exec(s);
  if (m) {
    const times = schedParseTimes(m[1]);
    return times ? { kind: "monthly", times } : { error: `Can't read the time in "${text}"` };
  }
  m = /^(.*?)\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*(?:,|and)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)*)$/.exec(s);
  if (!m || !m[1]) return { error: `Can't read the schedule "${text}"` };
  const times = schedParseTimes(m[2]);
  if (!times) return { error: `Can't read the time in "${text}"` };
  const dayPart = m[1].replace(/\s*(?:at|,)$/, "").trim();
  let days: Set<number> | null;
  if (dayPart === "daily" || dayPart === "every day" || dayPart === "everyday") days = new Set([0, 1, 2, 3, 4, 5, 6]);
  else if (dayPart === "weekdays" || dayPart === "every weekday") days = new Set([1, 2, 3, 4, 5]);
  else if (dayPart === "weekends" || dayPart === "every weekend") days = new Set([0, 6]);
  else days = schedParseDays(dayPart.replace(/^every\s+/, ""));
  if (!days || !days.size) return { error: `Can't read the days in "${text}"` };
  return { kind: "days", days, times };
}
export function schedFmtTime([h, m]: SchedTime): string {
  return `${h}:${String(m).padStart(2, "0")}`;
}
function schedJoin(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
const dayPlural = (x: number) => SCHED_DAY_NAMES[x][0].toUpperCase() + SCHED_DAY_NAMES[x].slice(1) + "s";
export function schedDescribe(rules: SchedParsed | null | undefined): string {
  if (!rules) return "";
  if ("error" in rules) return rules.error;
  if (rules.kind === "interval") {
    const m = rules.minutes;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const at = schedJoin(rules.times.map(schedFmtTime));
  if (rules.kind === "once") {
    const [y, mo, d] = rules.date;
    const day = new Date(y, mo, d);
    return `Once, on ${SCHED_DAY_SHORT[day.getDay()]} ${MONTHS[mo]} ${d}, ${y} at ${at}`;
  }
  if (rules.kind === "monthly") return `The first of each month at ${at}`;
  const d = rules.days;
  let days: string;
  if (d.size === 7) days = "Every day";
  else if (d.size === 5 && [1, 2, 3, 4, 5].every((x) => d.has(x))) days = "Weekdays";
  else if (d.size === 2 && d.has(0) && d.has(6)) days = "Weekends";
  else days = schedJoin([1, 2, 3, 4, 5, 6, 0].filter((x) => d.has(x)).map(dayPlural));
  return `${days} at ${at}`;
}
function schedAt(y: number, mo: number, d: number, h: number, min: number): Date {
  const t = new Date(y, mo, d, h, min, 0, 0);
  if (t.getHours() !== h || t.getMinutes() !== min) {
    if (t.getDate() === new Date(y, mo, d).getDate() && t.getHours() > h) return new Date(y, mo, d, t.getHours(), 0, 0, 0);
  }
  return t;
}
function schedOccurrencesOnDay(rules: SchedRules, day: Date): Date[] {
  const y = day.getFullYear(), mo = day.getMonth(), d = day.getDate();
  if (rules.kind === "interval") {
    const out: Date[] = [];
    for (let k = 0; k * rules.minutes < 24 * 60; k++) {
      const total = k * rules.minutes;
      const t = schedAt(y, mo, d, Math.floor(total / 60), total % 60);
      if (t.getDate() === d && !out.some((x) => x.getTime() === t.getTime())) out.push(t);
    }
    return out;
  }
  if (rules.kind === "monthly" && d !== 1) return [];
  if (rules.kind === "days" && !rules.days.has(new Date(y, mo, d).getDay())) return [];
  return rules.times.map(([h, min]) => schedAt(y, mo, d, h, min));
}
function schedOnce(rules: Extract<SchedRules, { kind: "once" }>): Date {
  const [y, mo, d] = rules.date;
  const [h, min] = rules.times[0];
  return schedAt(y, mo, d, h, min);
}
export function schedNext(rules: SchedParsed | null | undefined, after: Date): Date | null {
  if (isSchedError(rules)) return null;
  if (rules.kind === "once") { const t = schedOnce(rules); return t.getTime() > after.getTime() ? t : null; }
  const limit = rules.kind === "monthly" ? 62 : 8;
  for (let off = 0; off <= limit; off++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + off);
    const hit = schedOccurrencesOnDay(rules, day).find((t) => t.getTime() > after.getTime());
    if (hit) return hit;
  }
  return null;
}
export function schedPrev(rules: SchedParsed | null | undefined, at: Date): Date | null {
  if (isSchedError(rules)) return null;
  if (rules.kind === "once") { const t = schedOnce(rules); return t.getTime() <= at.getTime() ? t : null; }
  const limit = rules.kind === "monthly" ? 62 : 8;
  for (let off = 0; off <= limit; off++) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - off);
    const hits = schedOccurrencesOnDay(rules, day).filter((t) => t.getTime() <= at.getTime());
    if (hits.length) return hits[hits.length - 1];
  }
  return null;
}
export const NO_CATCH_UP_GRACE_MS = 10 * 60e3;
export function schedDue(rules: SchedParsed | null | undefined, now: Date, since: Date | null, lastSlot: Date | null, catchUp = true): { run?: Date; missed?: Date } {
  const latest = schedPrev(rules, now);
  if (!latest) return {};
  if (since && latest.getTime() < since.getTime()) return {};
  if (lastSlot && latest.getTime() <= lastSlot.getTime()) return {};
  const late = now.getTime() - latest.getTime();
  if (!catchUp) return late <= NO_CATCH_UP_GRACE_MS ? { run: latest } : { missed: latest };
  const following = schedNext(rules, latest);
  const interval = following ? following.getTime() - latest.getTime() : 24 * 3600e3;
  if (late < interval / 2) return { run: latest };
  return { missed: latest };
}
export function schedMinGap(rules: SchedParsed | null | undefined, from: Date): number | null {
  if (isSchedError(rules)) return null;
  if (rules.kind === "interval") return rules.minutes;
  let a = schedNext(rules, from), best: number | null = null;
  for (let i = 0; i < 20 && a; i++) {
    const b = schedNext(rules, a);
    if (!b) break;
    const gap = (b.getTime() - a.getTime()) / 60000;
    if (best == null || gap < best) best = gap;
    a = b;
  }
  return best;
}
export function schedShortWhen(t: Date | null, now: Date): string {
  if (!t) return "";
  const time = schedFmtTime([t.getHours(), t.getMinutes()]);
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayT = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diff = Math.round((dayT - day0) / 86400e3);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${SCHED_DAY_SHORT[t.getDay()]} ${time}`;
  return `${MONTHS[t.getMonth()]} ${t.getDate()} ${time}`;
}
export function schedFormat(rules: SchedParsed | null | undefined): string {
  if (isSchedError(rules)) return "";
  if (rules.kind === "interval") {
    const m = rules.minutes;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const at = rules.times.map(schedFmtTime).join(" and ");
  if (rules.kind === "once") return `Once ${rules.date[0]}-${String(rules.date[1] + 1).padStart(2, "0")}-${String(rules.date[2]).padStart(2, "0")} ${at}`;
  if (rules.kind === "monthly") return `First of the month ${at}`;
  const d = rules.days;
  if (d.size === 7) return `Daily ${at}`;
  if (d.size === 5 && [1, 2, 3, 4, 5].every((x) => d.has(x))) return `Weekdays ${at}`;
  if (d.size === 2 && d.has(0) && d.has(6)) return `Weekends ${at}`;
  return `${schedJoin([1, 2, 3, 4, 5, 6, 0].filter((x) => d.has(x)).map(dayPlural))} ${at}`;
}
