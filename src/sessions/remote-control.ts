import { fs, import_obsidian, os, path } from "../externals.js";
import { RC_PANEL_RE } from "./constants.js";
import type { Session } from "./controller.js";
import { notice } from "../vault-terminal/notice";

type RcState = "on" | "off" | "unknown";

const RC_COMMAND = "/remote-control";

class RemoteControlMethods {
  bridge(this: Session, id: string, atStart: boolean): void {
    if (this.getBackendKey() !== "claude") return;
    this._rcSeq++;
    if (id) this._setRc("on", id);
    else if (!atStart) this._setRc("off");
  }
  _setRc(this: Session, state: RcState, id = ""): void {
    if (this._rc === state && this._rcId === id) return;
    this._rc = state;
    this._rcId = id;
    this._syncRcDot();
  }
  _buildRcDot(this: Session, strip: HTMLElement): void {
    this._rcEl = null;
    if (this.getBackendKey() !== "claude" || this.plugin.pluginData.remoteControlDot === false) return;
    const el = strip.createSpan({ cls: "agent-manager-strip-rc", attr: { role: "button" } });
    el.addEventListener("click", () => { void this.sendRemoteControl(); });
    el.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const url = this._rc === "on" ? this._rcUrl() : "";
      const menu = new import_obsidian.Menu();
      menu.addItem((i) => i.setTitle(url ? "Copy claude.ai link" : "Copy claude.ai link (Remote Control isn't on)").setIcon("link").setDisabled(!url).onClick(() => {
        void navigator.clipboard.writeText(url).then(
          () => { notice("Copied the session's claude.ai link."); },
          () => { notice("Couldn't copy the link."); },
        );
      }));
      menu.showAtMouseEvent(evt);
    });
    this._rcEl = el;
    this._syncRcDot();
  }
  _rcUrl(this: Session): string {
    return this._rcId ? `https://claude.ai/code/${encodeURIComponent(this._rcId)}` : "";
  }
  _syncRcDot(this: Session): void {
    const el = this._rcEl;
    if (!el || !el.isConnected) return;
    const state = this._rc;
    el.toggleClass("is-on", state === "on");
    el.toggleClass("is-off", state === "off");
    el.toggleClass("is-unknown", state === "unknown");
    this._stripTip(el, state === "on"
      ? `Remote Control is on: ${this._rcUrl()}\n\nClick to see Claude's Remote Control panel (types ${RC_COMMAND}); right-click to copy the link.`
      : state === "off"
        ? `Remote Control is off for this session.\n\nClick to connect it (types ${RC_COMMAND}). If it's connected somewhere else, this moves it back here. If it doesn't connect, Claude says why in the session.`
        : `Remote Control: not known yet. Claude reports it at its next turn.\n\nClick to connect it, or if it's connected, to see Claude's panel (types ${RC_COMMAND}).`);
  }
  async sendRemoteControl(this: Session): Promise<void> {
    if (!this.running) { notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { this._notifyNeedsYou(`Not sent: you have unsent text in the prompt. Clear it, then click the Remote Control dot again.`); return; }
    if (this._dialogShowing()) { this._notifyNeedsYou("Not sent: the session is asking you something. Answer it, then click the Remote Control dot again."); return; }
    if (this._rcSending) return;
    this._rcSending = true;
    let sent = false;
    try { sent = await this.submitLine(RC_COMMAND); } finally { this._rcSending = false; }
    if (!sent) return;
    if (this._rc !== "on") void this._rcAfterReconnect();
    void this._rcWatchPanel();
  }
  _rcTyped(this: Session, data: string): void {
    if (this.getBackendKey() !== "claude" || !/\r/.test(data)) return;
    if (!/^\/(?:remote-control|rc)$/.test(this._draft.text().trim())) return;
    if (this._rc !== "on") void this._rcAfterReconnect();
    void this._rcWatchPanel();
  }
  async _rcWatchPanel(this: Session): Promise<void> {
    if (this._rcWatching) return;
    this._rcWatching = true;
    const attempt = this._attempt;
    const live = () => this._attempt === attempt && this.running && !this._closed;
    const panel = () => RC_PANEL_RE.test(this.view.screenTail(this.view.screenRows || 40));
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    try {
      let seen = false;
      const by = Date.now() + 15 * 60 * 1000;
      for (let t = 0; !seen && (t < 10 || (this.programState === "working" && Date.now() < by)); t++) { await wait(300); if (!live()) return; seen = panel(); }
      const end = Date.now() + 15 * 60 * 1000;
      while (seen && panel() && Date.now() < end) { await wait(500); if (!live()) return; }
      if (panel()) return;
      let rec: string | null = null;
      for (const ms of [500, 1000]) {
        await wait(ms);
        if (!live()) return;
        rec = (await this._rcRead(attempt)) ?? rec;
      }
      if (rec === null || !live()) return;
      if (rec) this._setRc("on", rec);
      else this._setRc("off");
    } finally {
      this._rcWatching = false;
    }
  }
  async _rcAfterReconnect(this: Session): Promise<void> {
    const attempt = this._attempt;
    for (const wait of [1000, 1500, 2500]) {
      await new Promise((r) => window.setTimeout(r, wait));
      if (this._attempt !== attempt || !this.running || this._closed || this._rc === "on") return;
      const bridge = await this._rcRead(attempt);
      if (bridge) { this._setRc("on", bridge); return; }
    }
  }
  async _rcRead(this: Session, attempt: number): Promise<string | null> {
    const id = this._ownSessionId();
    if (!id) return null;
    const seq = this._rcSeq;
    const rec = await claudeBridgeId(id, this._programPid);
    if (this._attempt !== attempt || !this.running || this._closed || this._rcSeq !== seq || this._ownSessionId() !== id) return null;
    return rec;
  }
}
async function claudeBridgeId(sessionId: string, pid: number | null): Promise<string | null> {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const found: { pid: unknown; bridge: unknown }[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const rec: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8"));
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      if (r.sessionId === sessionId) found.push({ pid: r.pid, bridge: r.bridgeSessionId });
    } catch { /* empty */ }
  }
  const alive = (p: unknown) => {
    if (typeof p !== "number" || !Number.isInteger(p) || p <= 0) return false;
    try { process.kill(p, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
  };
  const own = pid ? found.filter((r) => r.pid === pid) : [];
  const live = own.length ? own : found.filter((r) => alive(r.pid));
  if (live.length !== 1) return null;
  const bridge = live[0].bridge;
  return typeof bridge === "string" && /^[A-Za-z0-9_-]+$/.test(bridge) ? bridge : "";
}
export { RemoteControlMethods };
export type { RcState };
