
import { import_obsidian } from "../externals.js";
import { clockStep, runSlot, taskSince } from "../scheduled/clock-core.js";
import type { TaskSeen } from "../scheduled/clock-core.js";
import { runStarted } from "../scheduled/run-core.js";
import type { TaskView } from "./scheduler.js";
import type { AgentManagerPlugin } from "./main.js";
import type { NotifyRoute } from "../vault-terminal/core";
import { runNotifyKind } from "../scheduled/clock-core.js";

const SEEN_KEY = "agent-manager-sched-seen";
const ON_SINCE_KEY = "agent-manager-scheduler-on-since";

class ClockMethods {
  _taskSinceMap(this: AgentManagerPlugin, views: TaskView[], now: Date): Map<string, Date> {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(SEEN_KEY); } catch { /* empty */ }
    const prev = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, TaskSeen>) : {};
    let onSince = 0;
    try { onSince = Number(this.app.loadLocalStorage(ON_SINCE_KEY)) || 0; } catch { /* empty */ }
    const touched = this.taskTouched();
    const keep: Record<string, TaskSeen> = { ...prev };
    const out = new Map<string, Date>();
    for (const v of views) {
      const t = v.task;
      const f = this.app.vault.getAbstractFileByPath(t.notePath);
      const mtime = f instanceof import_obsidian.TFile ? f.stat.mtime : null;
      const p = prev[t.folder];
      const valid = p && typeof p === "object" && typeof p.since === "number" && typeof p.schedule === "string" ? p : null;
      const { seen, since } = taskSince(valid, { schedule: t.scheduleText, paused: t.paused }, now.getTime(), mtime, onSince, touched[t.notePath] || 0);
      keep[t.folder] = seen;
      out.set(t.folder, new Date(since));
    }
    try { this.app.saveLocalStorage(SEEN_KEY, keep); } catch { /* empty */ }
    return out;
  }
  async schedulerTick(this: AgentManagerPlugin): Promise<void> {
    if (this._tickBusy || this._unloading || !this.scheduledTasksOn()) return;
    this._tickBusy = true;
    try {
      this._taskCache = null;
      const views = await this.taskViews();
      const since = this._taskSinceMap(views, new Date());
      const cap = this.schedSettings().runsAtOnce;
      if (!this._waited) this._waited = new Set();
      for (const v of views) {
        if (this._unloading || !this.schedulerOn()) return;
        const t = v.task;
        if (t.paused || t.problems.length || !v.approved) continue;
        const step = clockStep({ rules: t.rules, now: new Date(), since: since.get(t.folder) ?? null, rows: v.runs, catchUp: t.catchUp, retry: t.mode !== "full" });
        if (step.action === "none") continue;
        const slot = runSlot(step.slot);
        if (this.runFor(t)) {
          if (step.action === "run" && step.attempt === 1) (this._busyWaited || (this._busyWaited = new Set())).add(`${t.folder}|${slot}`);
          continue;
        }
        if (step.action === "skipped") {
          if (await this._logClockRow(v, slot, "skipped", "Held after three failed runs in a row: Run now to try again.")) {
            this.notifyDesktop(`Scheduled task held: ${t.label}`, "Three runs in a row failed, so it won't run again until a run succeeds. Run now to try it.", t.notePath);
          }
        } else if (step.action === "run") {
          if (this.activeRunCount() >= cap) { this._waited.add(`${t.folder}|${slot}`); continue; }
          if (this.safetyAutoOn()) {
            const gate = await this.safetyGateFor(v);
            if (gate.state !== "ok") {
              (this._safetyWaited || (this._safetyWaited = new Set())).add(`${t.folder}|${slot}`);
              if (gate.state === "check") { const c = await this.safetyClaude(); this.safetyAutoCheck(gate.phases, "error" in c ? null : this.safetyKeys(c)); }
              continue;
            }
          }
          void this.runScheduledTask(v, { occurrence: slot, attempt: step.attempt, quiet: true });
        } else {
          const waited = this._waited.delete(`${t.folder}|${slot}`);
          const safety = this._safetyWaited?.delete(`${t.folder}|${slot}`) ?? false;
          const busy = this._busyWaited?.delete(`${t.folder}|${slot}`) ?? false;
          const refused = this._startRefused?.get(`${t.folder}|${slot}`);
          this._startRefused?.delete(`${t.folder}|${slot}`);
          await this._logClockRow(v, slot, "missed", refused ? `It couldn't start until it was too late to catch up: ${refused.replace(/^“[^”]*” /, "it ")}` : busy ? "Its last run was still going (waiting for you, or past its time limit) until it was too late to catch up." : safety ? "The run safety check hadn't passed on this Claude Code (it was held, or waiting for a check) until it was too late to catch up." : waited ? "Other runs were going until it was too late to catch up." : "Obsidian was closed or the computer asleep then, and it was too late to catch up.");
        }
      }
    } catch (e) {
      console.error("[Agent Manager] scheduler check failed:", e);
    } finally {
      this._tickBusy = false;
    }
  }
  async _logClockRow(this: AgentManagerPlugin, v: TaskView, slot: string, outcome: string, note: string): Promise<boolean> {
    const t = v.task;
    const ok = await this.writeRunRow(t.folder, { Started: runStarted(new Date()), Occurrence: slot, Attempt: "", Outcome: outcome, Took: "", Result: "", Session: "", Backend: "", Machine: this.machineName(), Note: note });
    if (!ok || this._unloading) return ok;
    if (this.schedSettings().commitRuns) await this.commitPaths([this.runLogPath(t.folder)], `Scheduled: ${t.label}, ${slot} ${outcome}${outcome === "skipped" ? " (held)" : ""}`);
    this._taskCache = null;
    this.refreshBrowsers();
    return true;
  }
  _notifyRunEnd(this: AgentManagerPlugin, label: string, notePath: string, outcome: string, note: string, scheduled: boolean): void {
    const kind = runNotifyKind(outcome, scheduled);
    const s = this.schedSettings();
    if (kind === "problem") this.notifyDesktop(`Scheduled task ${outcome}: ${label}`, note || outcome, notePath);
    else if (kind === "fine") this.notifyDesktop(label, note || "Finished.", notePath, { to: s.fineTo, seconds: s.fineSeconds });
  }
  notifyDesktop(this: AgentManagerPlugin, title: string, body: string, notePath: string, kind: NotifyRoute = "needs"): void {
    this.notify(title, body, () => { void this.openTaskPage(notePath); }, notePath ? `task:${notePath}` : undefined, kind);
  }
  notify(this: AgentManagerPlugin, title: string, body: string, onClick?: () => void, key?: string, kind: NotifyRoute = "needs"): void {
    if (this.terminal) { this.terminal.notify(title, body, onClick, key, kind); return; }
    if (kind !== "needs") return;
    try {
      const n = new window.Notification(title, { body: body.slice(0, 240), silent: false });
      n.onclick = () => { window.focus(); onClick?.(); };
    } catch (e) { console.error("[Agent Manager] desktop notification failed:", e); }
  }
  async openTaskPage(this: AgentManagerPlugin, notePath: string): Promise<void> {
    await this.revealBrowser();
    for (const b of this.browserViews()) {
      b.browserScope = notePath ? { page: "task", notePath } : { page: "tasks" };
      b.renderBrowser();
    }
  }
}
export { ClockMethods };
