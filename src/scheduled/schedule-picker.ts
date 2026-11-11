
import { SCHED_DAY_NAMES, schedDescribe, schedFormat, schedNext, schedParse, schedShortWhen } from "./schedule-core.js";
import type { SchedRules, SchedTime } from "./schedule-core.js";

type Mode = "daily" | "weekdays" | "weekends" | "days" | "hours" | "minutes" | "monthly" | "once";

export function buildSchedulePicker(el: HTMLElement, line: string, onChange: (line: string) => void): void {
  const parsed = line ? schedParse(line) : null;
  const r: SchedRules | null = parsed && !("error" in parsed) ? parsed : null;
  const today = new Date();
  const st = { mode: "daily" as Mode, days: new Set([1]), time: [7, 0] as SchedTime, hours: 2, minutes: 30, date: [today.getFullYear(), today.getMonth(), today.getDate() + 1] as [number, number, number] };
  if (r) {
    if (r.kind === "interval") {
      if (r.minutes % 60 === 0) { st.mode = "hours"; st.hours = r.minutes / 60; } else { st.mode = "minutes"; st.minutes = r.minutes; }
    } else {
      st.time = r.times[0];
      if (r.kind === "once") { st.mode = "once"; st.date = [...r.date]; }
      else if (r.kind === "monthly") st.mode = "monthly";
      else if (r.days.size === 7) st.mode = "daily";
      else if (r.days.size === 5 && [1, 2, 3, 4, 5].every((x) => r.days.has(x))) st.mode = "weekdays";
      else if (r.days.size === 2 && r.days.has(0) && r.days.has(6)) st.mode = "weekends";
      else { st.mode = "days"; st.days = new Set(r.days); }
    }
  }
  const picker = el.createDiv({ cls: "agent-manager-task-picker" });
  const row = picker.createDiv({ cls: "agent-manager-task-picker-row" });
  const mode = row.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Repeat" } });
  const modes: [Mode, string][] = [["daily", "Every day"], ["weekdays", "Weekdays"], ["weekends", "Weekends"], ["days", "Specific days"], ["hours", "Every few hours"], ["minutes", "Every few minutes"], ["monthly", "First of the month"], ["once", "Once"]];
  for (const [v, label] of modes) mode.createEl("option", { value: v, text: label });
  mode.value = st.mode;
  const time = row.createDiv({ cls: "agent-manager-task-picker-time" });
  const [h0, m0] = st.time;
  const hourSel = time.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Hour" } });
  for (let n = 1; n <= 12; n++) hourSel.createEl("option", { value: String(n), text: String(n) });
  hourSel.value = String(h0 % 12 === 0 ? 12 : h0 % 12);
  const minSel = time.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Minute" } });
  for (const n of [...new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, m0])].sort((a, b) => a - b)) minSel.createEl("option", { value: String(n), text: String(n).padStart(2, "0") });
  minSel.value = String(m0);
  const ampm = time.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Morning or afternoon" } });
  ampm.createEl("option", { value: "am", text: "AM" });
  ampm.createEl("option", { value: "pm", text: "PM" });
  ampm.value = h0 >= 12 ? "pm" : "am";
  const hours = row.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "How often" } });
  for (const n of [1, 2, 3, 4, 6, 8, 12]) hours.createEl("option", { value: String(n), text: n === 1 ? "every hour" : `every ${n} hours` });
  hours.value = String(st.hours);
  const minutes = row.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "How often" } });
  for (const n of [15, 20, 30]) minutes.createEl("option", { value: String(n), text: `every ${n} minutes` });
  minutes.value = String(st.minutes);
  const dateRow = picker.createDiv({ cls: "agent-manager-task-picker-row" });
  const d0 = new Date(st.date[0], st.date[1], st.date[2]);
  const monSel = dateRow.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Month" } });
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].forEach((n, i) => monSel.createEl("option", { value: String(i), text: n }));
  monSel.value = String(d0.getMonth());
  const daySel = dateRow.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Day" } });
  for (let n = 1; n <= 31; n++) daySel.createEl("option", { value: String(n), text: String(n) });
  daySel.value = String(d0.getDate());
  const yearSel = dateRow.createEl("select", { cls: "dropdown agent-manager-ticket-select", attr: { "aria-label": "Year" } });
  for (const y of [...new Set([today.getFullYear(), today.getFullYear() + 1, d0.getFullYear()])].sort()) yearSel.createEl("option", { value: String(y), text: String(y) });
  yearSel.value = String(d0.getFullYear());
  const dayRow = picker.createDiv({ cls: "agent-manager-task-picker-days" });
  for (const [d, letter] of [[1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [0, "S"]] as [number, string][]) {
    const b = dayRow.createEl("button", { text: letter, cls: "agent-manager-task-picker-day", attr: { "aria-label": SCHED_DAY_NAMES[d] } });
    b.toggleClass("is-on", st.days.has(d));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (st.days.has(d)) st.days.delete(d); else st.days.add(d);
      b.toggleClass("is-on", st.days.has(d));
      changed();
    });
  }
  const readBack = picker.createDiv({ cls: "agent-manager-task-picker-note" });
  const current = (): string => {
    const m = mode.value as Mode;
    if (m === "hours") return schedFormat({ kind: "interval", minutes: Number(hours.value) * 60 });
    if (m === "minutes") return schedFormat({ kind: "interval", minutes: Number(minutes.value) });
    const times: SchedTime[] = [[Number(hourSel.value) % 12 + (ampm.value === "pm" ? 12 : 0), Number(minSel.value)]];
    if (m === "monthly") return schedFormat({ kind: "monthly", times });
    if (m === "once") {
      const y = Number(yearSel.value), mo = Number(monSel.value), d = Number(daySel.value);
      if (new Date(y, mo, d).getMonth() !== mo) return "";
      return schedFormat({ kind: "once", date: [y, mo, d], times });
    }
    const days = m === "daily" ? new Set([0, 1, 2, 3, 4, 5, 6]) : m === "weekdays" ? new Set([1, 2, 3, 4, 5]) : m === "weekends" ? new Set([0, 6]) : st.days;
    if (!days.size) return "";
    return schedFormat({ kind: "days", days, times });
  };
  const changed = () => {
    const m = mode.value as Mode;
    time.toggleClass("agent-manager-hidden", m === "hours" || m === "minutes");
    hours.toggleClass("agent-manager-hidden", m !== "hours");
    minutes.toggleClass("agent-manager-hidden", m !== "minutes");
    dayRow.toggleClass("agent-manager-hidden", m !== "days");
    dateRow.toggleClass("agent-manager-hidden", m !== "once");
    const l = current();
    const rr = l ? schedParse(l) : null;
    const ok = rr && !("error" in rr) ? rr : null;
    const nx = ok ? schedNext(ok, new Date()) : null;
    readBack.setText(ok ? `${schedDescribe(ok)}. ${nx ? `Next: ${schedShortWhen(nx, new Date())}.` : "That time has passed."}` : m === "once" ? "That date doesn't exist." : "Pick at least one day.");
    onChange(ok ? l : "");
  };
  for (const c of [mode, hourSel, minSel, ampm, hours, minutes, monSel, daySel, yearSel]) c.addEventListener("change", changed);
  changed();
}
